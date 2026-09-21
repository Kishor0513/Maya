import type { Memory, MemoryCategory } from '../../types';
import { gatewayHeaders } from '../gateway';

// MemoryService — local persistent store + backend sync surface.
// Frontend contract mirrors:
//   GET/POST /api/memories, PATCH/DELETE /api/memories/:id
// Local-first so demo mode works; syncs opportunistically when a backend exists.

const KEY = 'maya.memories.v1';
const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

function load(): Memory[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Memory[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(m: Memory[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* storage full / private mode — non-fatal */
  }
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'i', 'you', 'he', 'she', 'it', 'we',
  'my', 'your', 'is', 'are', 'was', 'very', 'really', 'just', 'like',
]);

function keywords(text: string): string[] {
  return text
    .toLowerCase()
    // eslint-disable-next-line no-misleading-character-class -- Devanagari block intentionally includes combining marks
    .replace(/[^a-z0-9\u0900-\u097f\s]/giu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 24);
}

/** Term-frequency vector over content words. Pure — unit-tested. */
export function termVector(text: string): Map<string, number> {
  const vec = new Map<string, number>();
  for (const w of keywords(text)) vec.set(w, (vec.get(w) ?? 0) + 1);
  return vec;
}

/** IDF-weighted Euclidean norm for cosine similarity. */
export function weightedNorm(vec: Map<string, number>, idf: (t: string) => number): number {
  let sum = 0;
  for (const [t, tf] of vec) {
    const w = tf * idf(t);
    sum += w * w;
  }
  return Math.sqrt(sum);
}

export class MemoryService {
  private items: Memory[] = load();

  all(): Memory[] {
    return [...this.items].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** TF-IDF cosine ranking over memory texts (local semantic-lite retrieval). */
  retrieve(query: string, limit = 6): Memory[] {
    const qvec = termVector(query);
    if (qvec.size === 0) return this.items.slice(0, limit);
    const docs = this.items.map((m) => ({
      m,
      vec: termVector(`${m.key} ${m.value} ${m.type}`),
    }));
    const df = new Map<string, number>();
    for (const d of docs) {
      for (const t of d.vec.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = Math.max(1, docs.length);
    const idf = (t: string): number => Math.log(1 + n / (1 + (df.get(t) ?? 0)));
    const qnorm = weightedNorm(qvec, idf);
    const scored = docs.map(({ m, vec }) => {
      let dot = 0;
      for (const [t, tf] of vec) {
        const qtf = qvec.get(t);
        if (qtf !== undefined) dot += tf * qtf * idf(t) ** 2;
      }
      const dnorm = weightedNorm(vec, idf);
      const cos = qnorm > 0 && dnorm > 0 ? dot / (qnorm * dnorm) : 0;
      // Confidence + gentle recency priors keep ranking stable, not jumpy.
      const ageDays = (Date.now() - m.lastAccessedAt) / 86_400_000;
      return { m, score: cos * 2 + m.confidence * 0.3 - Math.min(0.3, ageDays / 200) };
    });
    const out = scored
      .filter((s) => s.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.m);
    const now = Date.now();
    for (const m of out) m.lastAccessedAt = now;
    if (out.length) save(this.items);
    return out;
  }

  upsert(input: {
    type: MemoryCategory;
    key: string;
    value: string;
    confidence?: number;
    sourceConversationId?: string;
  }): Memory {
    const key = input.key.trim().toLowerCase().replace(/\s+/g, '_');
    const existing = this.items.find((m) => m.key === key && m.type === input.type);
    const now = Date.now();
    if (existing) {
      existing.value = input.value;
      existing.confidence = Math.max(existing.confidence, input.confidence ?? 0.7);
      existing.updatedAt = now;
      existing.lastAccessedAt = now;
      save(this.items);
      void this.syncPush(existing);
      return existing;
    }
    const m: Memory = {
      id: crypto.randomUUID(),
      type: input.type,
      key,
      value: input.value,
      confidence: input.confidence ?? 0.7,
      sourceConversationId: input.sourceConversationId,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
    };
    this.items.unshift(m);
    save(this.items);
    void this.syncPush(m);
    return m;
  }

  /** Heuristic extraction — backend should run the real LLM extractor. */
  extractFromTurn(userText: string, conversationId: string): Memory[] {
    const out: Memory[] = [];
    const t = userText.trim();
    if (t.length < 8 || t.length > 500) return out;
    const patterns: { re: RegExp; type: MemoryCategory; key: string }[] = [
      // eslint-disable-next-line no-misleading-character-class -- Devanagari block intentionally includes combining marks
      { re: /my name is ([A-Za-z\u0900-\u097F][\w\u0900-\u097F .-]{1,30})/iu, type: 'profile', key: 'preferred_name' },
      // eslint-disable-next-line no-misleading-character-class -- Devanagari block intentionally includes combining marks
      { re: /call me ([A-Za-z\u0900-\u097F][\w\u0900-\u097F .-]{1,30})/iu, type: 'profile', key: 'preferred_name' },
      { re: /i (?:work (?:as|on)|am a|do) ([^.!?]{3,60})/i, type: 'profile', key: 'work' },
      { re: /i (?:love|like|enjoy|prefer) ([^.!?]{3,60})/i, type: 'preference', key: 'likes' },
      { re: /my favorite ([a-z ]{2,24}) is ([^.!?]{2,60})/i, type: 'preference', key: 'favorite' },
      { re: /i (?:hate|dislike) ([^.!?]{3,60})/i, type: 'preference', key: 'dislikes' },
      { re: /my (?:goal|plan) (?:is to )?([^.!?]{4,80})/i, type: 'goal', key: 'goal' },
      { re: /i'?m (?:working on|building) ([^.!?]{3,80})/i, type: 'project', key: 'project' },
    ];
    for (const p of patterns) {
      const m = t.match(p.re);
      if (m) {
        const value = (m[2] ?? m[1]).trim();
        // Avoid storing sensitive-looking content silently.
        if (/password|ssn|credit|card number|otp/i.test(value)) continue;
        out.push(
          this.upsert({
            type: p.type,
            key: p.key === 'favorite' ? `favorite_${m[1].trim()}` : p.key,
            value,
            confidence: 0.75,
            sourceConversationId: conversationId,
          }),
        );
        break; // one extraction per turn keeps memory deliberate, not invasive
      }
    }
    return out;
  }

  update(id: string, patch: Partial<Pick<Memory, 'value' | 'key'>>): Memory | null {
    const m = this.items.find((x) => x.id === id);
    if (!m) return null;
    if (patch.value !== undefined) m.value = patch.value;
    if (patch.key !== undefined) m.key = patch.key;
    m.updatedAt = Date.now();
    save(this.items);
    return m;
  }

  remove(id: string): void {
    this.items = this.items.filter((m) => m.id !== id);
    save(this.items);
    if (API_BASE) {
      fetch(`${API_BASE}/api/memories/${id}`, {
        method: 'DELETE',
        headers: gatewayHeaders(),
        credentials: 'include',
      }).catch(() => undefined);
    }
  }

  clear(): void {
    this.items = [];
    save(this.items);
  }

  private async syncPush(m: Memory): Promise<void> {
    if (!API_BASE) return;
    try {
      await fetch(`${API_BASE}/api/memories`, {
        method: 'POST',
        headers: gatewayHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'include',
        body: JSON.stringify(m),
      });
    } catch {
      /* offline — local copy remains source of truth */
    }
  }

  async syncPull(): Promise<void> {
    if (!API_BASE) return;
    try {
      const res = await fetch(`${API_BASE}/api/memories`, {
        headers: gatewayHeaders(),
        credentials: 'include',
      });
      if (!res.ok) return;
      const remote = (await res.json()) as Memory[];
      if (Array.isArray(remote) && remote.length > 0) {
        const seen = new Set(this.items.map((m) => m.id));
        for (const m of remote) if (!seen.has(m.id)) this.items.push(m);
        save(this.items);
      }
    } catch {
      /* ignore */
    }
  }
}

export const memoryService = new MemoryService();
