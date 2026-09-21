import type { MayaTool } from '../../types';
import { gatewayHeaders } from '../gateway';
import { textToSpeech } from '../speech/TextToSpeech';

// Client-visible tool registry. Privileged execution (web, weather, voice)
// happens server-side; local tools (calculator, notes, reminders, calendar)
// run on-device with localStorage persistence.

// ─── natural time parsing ("in 10 minutes", "at 18:30", "tomorrow at 9am") ──

export function parseWhen(input: string, from = Date.now()): number | null {
  const t = input.toLowerCase().trim();
  if (!t) return null;
  let m = t.match(/in\s+(\d+)\s*(second|minute|hour)s?\b/);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
    const mult = m[2].startsWith('second') ? 1000 : m[2].startsWith('minute') ? 60000 : 3600000;
    return from + n * mult;
  }
  m = t.match(/(?:(tomorrow)\s+)?at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (m) {
    let h = Number(m[2]);
    const min = Number(m[3] ?? 0);
    const ap = m[4];
    if (h > 23 || min > 59) return null;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const d = new Date(from);
    if (m[1]) d.setDate(d.getDate() + 1);
    d.setHours(h, min, 0, 0);
    let ts = d.getTime();
    if (ts <= from) ts += 86400000; // next occurrence
    return ts;
  }
  return null;
}

export function describeWhen(at: number): string {
  const diff = at - Date.now();
  if (diff <= 0) return 'now';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'in under a minute';
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `in ${h} hour${h === 1 ? '' : 's'}`;
  return new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// ─── reminders (spoken + Notification, survive reloads) ─────────────────────

export interface Reminder {
  id: string;
  text: string;
  at: number;
  created: number;
}

export interface CalEvent {
  id: string;
  title: string;
  at: number;
  created: number;
}

const RKEY = 'maya.reminders.v1';
const EKEY = 'maya.events.v1';
const timers = new Map<string, number>();

function load<T>(key: string): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export function listReminders(): Reminder[] {
  return load<Reminder>(RKEY).sort((a, b) => a.at - b.at);
}

export function cancelReminder(id: string): boolean {
  const all = load<Reminder>(RKEY);
  const kept = all.filter((r) => r.id !== id);
  if (kept.length === all.length) return false;
  const h = timers.get(id);
  if (h !== undefined) {
    window.clearTimeout(h);
    timers.delete(id);
  }
  save(RKEY, kept);
  return true;
}

export function listEvents(): CalEvent[] {
  return load<CalEvent>(EKEY).sort((a, b) => a.at - b.at);
}

export function cancelEvent(id: string): boolean {
  const all = load<CalEvent>(EKEY);
  const kept = all.filter((e) => e.id !== id);
  if (kept.length === all.length) return false;
  save(EKEY, kept);
  return true;
}

function fireReminder(id: string): void {
  timers.delete(id);
  const all = load<Reminder>(RKEY);
  const r = all.find((x) => x.id === id);
  if (!r) return;
  save(RKEY, all.filter((x) => x.id !== id));
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Maya reminder', { body: r.text });
    }
  } catch {
    /* notifications unavailable — voice still fires */
  }
  void textToSpeech.speak(`Reminder: ${r.text}`, {}).catch(() => undefined);
}

function scheduleReminder(r: Reminder): void {
  const prev = timers.get(r.id);
  if (prev !== undefined) window.clearTimeout(prev);
  // Overdue (e.g. browser was closed) fires shortly after load.
  const delay = r.at <= Date.now() ? 1500 : r.at - Date.now();
  timers.set(r.id, window.setTimeout(() => fireReminder(r.id), Math.min(delay, 2147000000)));
}

/** Reschedule persisted reminders (call once on app start). */
export function initReminders(): void {
  try {
    for (const r of listReminders()) scheduleReminder(r);
  } catch {
    /* non-browser env */
  }
}

// ─── registry ────────────────────────────────────────────────────────────────

const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

export async function callGatewayTool(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/${path}`, {
    method: 'POST',
    headers: gatewayHeaders({ 'Content-Type': 'application/json' }),
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (res.status === 501) {
    const data = (await res.json().catch(() => null)) as { setup?: string } | null;
    throw new Error(data?.setup ?? 'Tool not configured on the gateway.');
  }
  if (!res.ok) throw new Error('Tool unavailable');
  return (await res.json()) as unknown;
}

export const MAYA_TOOLS: MayaTool[] = [
  {
    name: 'calculator',
    description: 'Evaluate a basic arithmetic expression locally.',
    execute: async (args: unknown) => {
      const expr = String((args as { expr?: unknown })?.expr ?? '');
      if (!/^[0-9+\-*/().\s%^]+$/.test(expr) || expr.length > 60)
        throw new Error('Unsafe expression');
      const sanitized = expr.replace(/\^/g, '**');
      const fn = new Function(`return (${sanitized})`);
      const value = fn() as unknown;
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error('No numeric result');
      return { result: value };
    },
  },
  {
    name: 'web_search',
    description: 'Search the web via the backend gateway (Wikipedia + DDG, no key).',
    execute: async (args: unknown) => {
      const q = String((args as { query?: unknown })?.query ?? '').slice(0, 200);
      return callGatewayTool('tools/web_search', { query: q });
    },
  },
  {
    name: 'weather',
    description: 'Current weather via the gateway (Open-Meteo, no key). Args {location} or {lat, lon}.',
    execute: async (args: unknown) => {
      const a = (args ?? {}) as Record<string, unknown>;
      return callGatewayTool('tools/weather', {
        location: typeof a.location === 'string' ? a.location.slice(0, 80) : undefined,
        lat: typeof a.lat === 'number' ? a.lat : undefined,
        lon: typeof a.lon === 'number' ? a.lon : undefined,
      });
    },
  },
  {
    name: 'reminder',
    description:
      'Set a spoken reminder. Args {text, when} where when is like "in 10 minutes" or "at 18:30".',
    execute: async (args: unknown) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const text = String(a.text ?? '').trim().slice(0, 200);
      const whenRaw = String(a.when ?? '').trim();
      if (!text) throw new Error('Reminder needs text');
      const at = parseWhen(whenRaw);
      if (!at) throw new Error('Could not parse time — use "in N minutes" or "at HH:MM"');
      if (at - Date.now() > 7 * 86400000) throw new Error('Too far ahead (max 7 days)');
      try {
        if ('Notification' in window && Notification.permission === 'default') {
          await Notification.requestPermission();
        }
      } catch {
        /* proceed with voice only */
      }
      const r: Reminder = { id: crypto.randomUUID(), text, at, created: Date.now() };
      const all = load<Reminder>(RKEY);
      all.push(r);
      save(RKEY, all);
      scheduleReminder(r);
      return { scheduled: true, at, text };
    },
  },
  {
    name: 'calendar',
    description: 'Save a local calendar event. Args {title, when} like the reminder tool.',
    execute: async (args: unknown) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const title = String(a.title ?? '').trim().slice(0, 200);
      const at = parseWhen(String(a.when ?? ''));
      if (!title) throw new Error('Event needs a title');
      if (!at) throw new Error('Could not parse time — use "in N minutes" or "at HH:MM"');
      const e: CalEvent = { id: crypto.randomUUID(), title, at, created: Date.now() };
      const all = load<CalEvent>(EKEY);
      all.push(e);
      save(EKEY, all);
      return { saved: true, at, title };
    },
  },
  {
    name: 'notes',
    description: 'Save a quick note to local storage.',
    execute: async (args: unknown) => {
      const text = String((args as { text?: unknown })?.text ?? '').slice(0, 500);
      const prev = load<string>('maya.notes.v1');
      prev.unshift(`${new Date().toISOString()}: ${text}`);
      save('maya.notes.v1', prev.slice(0, 100));
      return { saved: true };
    },
  },
  {
    name: 'music',
    description: 'Play music (requires a connected provider).',
    execute: async () => {
      throw new Error(
        'Music needs a connected provider (Spotify/Apple Music). Connect provider credentials server-side first.',
      );
    },
  },
  {
    name: 'smarthome',
    description: 'Control smart-home devices (requires a connected provider).',
    execute: async () => {
      throw new Error(
        'Smart home needs a connected provider (Home Assistant/Hue). Connect provider credentials server-side first.',
      );
    },
  },
];

export function getTool(name: string): MayaTool | undefined {
  return MAYA_TOOLS.find((t) => t.name === name);
}
