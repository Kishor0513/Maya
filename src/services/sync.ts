import { supabaseCloud } from './supabaseClient';
import { gatewayHeaders } from './gateway';
import { textToSpeech } from './speech/TextToSpeech';
import { useConversationStore } from '../stores/conversationStore';
import type { ChatMessage, Conversation } from '../types';

const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

function toChatMessage(conversationId: string, m: Record<string, unknown>): ChatMessage | null {
  if (typeof m.id !== 'string' || typeof m.text !== 'string') return null;
  if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') return null;
  return {
    id: m.id,
    conversationId,
    role: m.role,
    text: m.text,
    timestamp: typeof m.created === 'number' ? m.created : Date.now(),
    images: Array.isArray(m.images)
      ? (m.images as unknown[]).filter((u): u is string => typeof u === 'string')
      : undefined,
  };
}

/** Pull remote conversations, merging remote-newer over local. */
export async function pullConversations(): Promise<void> {
  const sb = await supabaseCloud();
  if (!sb) return;
  const st = useConversationStore.getState();
  const { data: remote } = await sb
    .from('conversations')
    .select('*')
    .order('updated', { ascending: false })
    .limit(50);
  if (!remote) return;
  for (const r of remote as Record<string, unknown>[]) {
    const rid: unknown = r.id;
    if (typeof rid !== 'string') continue;
    const { data: msgs } = await sb
      .from('messages')
      .select('*')
      .eq('conversation_id', rid)
      .order('created', { ascending: true })
      .limit(300);
    const messages = ((msgs ?? []) as Record<string, unknown>[])
      .map((m) => toChatMessage(rid, m))
      .filter((m): m is ChatMessage => m !== null);
    const c: Conversation = {
      id: rid,
      title: typeof r.title === 'string' && r.title ? r.title : 'Conversation',
      createdAt: typeof r.created === 'number' ? r.created : Date.now(),
      updatedAt: typeof r.updated === 'number' ? r.updated : Date.now(),
      messages,
      summary: typeof r.summary === 'string' ? r.summary : undefined,
    };
    const local = st.conversations.find((x) => x.id === c.id);
    if (!local) st.importConversation(c);
    else if (c.updatedAt > local.updatedAt) st.replaceConversation(c);
  }
}

/** Push one conversation (upsert + message replace). Last-write-wins. */
export async function pushConversation(id: string): Promise<void> {
  const sb = await supabaseCloud();
  if (!sb) return;
  const st = useConversationStore.getState();
  const c = st.conversations.find((x) => x.id === id);
  if (!c) return;
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return;
  await sb.from('conversations').upsert({
    id: c.id,
    owner: user.id,
    title: c.title,
    created: c.createdAt,
    updated: c.updatedAt,
    summary: c.summary ?? null,
  });
  await sb.from('messages').delete().eq('conversation_id', id);
  if (c.messages.length > 0) {
    await sb.from('messages').insert(
      c.messages.map((m) => ({
        id: m.id,
        conversation_id: id,
        owner: user.id,
        role: m.role,
        text: m.text,
        images: m.images ?? [],
        created: m.timestamp,
      })),
    );
  }
}

/** Realtime: conversation changes + reminder delivery pings. */
export function subscribeSync(
  onConversation: (id: string) => void,
  onReminders: () => void,
): () => void {
  let active = true;
  let channel: { unsubscribe: () => Promise<string> } | null = null;
  void (async () => {
    const sb = await supabaseCloud();
    if (!sb || !active) return;
    const ch = sb
      .channel('maya-sync')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        (p: { new?: { id?: string }; old?: { id?: string } }) => {
          const id = p.new?.id ?? p.old?.id;
          if (id) onConversation(id);
        },
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reminders' }, () => {
        onReminders();
      });
    ch.subscribe();
    channel = ch;
  })();
  return () => {
    active = false;
    try {
      void channel?.unsubscribe?.();
    } catch {
      /* ignore */
    }
  };
}

// ─── server reminders: announce newly delivered ones ─────────────────────────

const SEEN_KEY = 'maya.reminders.seen.v1';

function loadSeen(): Record<string, { text: string; at: number }> {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, { text: string; at: number }>) : {};
  } catch {
    return {};
  }
}

/** Speak + notify for reminders the server just delivered. Call on mount, online, and realtime pings. */
export async function checkDeliveredReminders(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/reminders`, {
      headers: gatewayHeaders(),
      credentials: 'include',
    });
    if (!res.ok) return;
    const list = ((await res.json()) as { id: string; text: string; at: number }[]).filter(
      (r) => r && typeof r.id === 'string',
    );
    const seen = loadSeen();
    const now = Date.now();
    for (const [id, old] of Object.entries(seen)) {
      if (!list.some((r) => r.id === id) && old.at <= now + 60000) {
        try {
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('Maya reminder', { body: old.text });
          }
        } catch {
          /* voice still fires */
        }
        await textToSpeech.speak(`Reminder: ${old.text}`, {}).catch(() => undefined);
      }
      delete seen[id];
    }
    const next: Record<string, { text: string; at: number }> = {};
    for (const r of list) next[r.id] = { text: r.text, at: r.at };
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  } catch {
    /* offline */
  }
}

// ─── offline outbox: failed sends retry when back online ─────────────────────

export interface OutboxItem {
  id: string;
  text: string;
  images: string[];
  conversationId: string | null;
  at: number;
}

const OKEY = 'maya.outbox.v1';

export function peekOutbox(): OutboxItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(OKEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as OutboxItem[]) : [];
  } catch {
    return [];
  }
}

export function stashOutbox(item: Omit<OutboxItem, 'id' | 'at'>): void {
  try {
    const all = [{ ...item, id: crypto.randomUUID(), at: Date.now() }, ...peekOutbox()].slice(0, 5);
    localStorage.setItem(OKEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

export function clearOutbox(ids: string[]): void {
  try {
    localStorage.setItem(OKEY, JSON.stringify(peekOutbox().filter((i) => !ids.includes(i.id))));
  } catch {
    /* ignore */
  }
}
