/**
 * Maya persistent storage — Supabase Postgres backend.
 * Replaces the old sqlite/JSON store. Keeps the same public API surface
 * so the gateway stays thin. No migrations needed; tables are created
 * by the SQL schema (see README).
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in server/.env. ' +
    'Copy server/.env.example and fill in your Supabase credentials.'
  );
}

// Server-side client bypasses RLS (service role). The frontend should
// use the anon key + user JWT if you later expose tables directly.
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

/** Deterministic owner id: from token when logged in, else 'local'. */
export function ownerOf(req) {
  if (!req || !req.headers) return 'local';
  const h = req.headers.authorization ?? '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return 'local';
  // token is opaque; map deterministically via sha256 so the same token
  // always gets the same owner id without a DB round-trip.
  const hash = crypto.createHash('sha256').update(m[1]).digest('hex');
  return hash.slice(0, 16);
}

export const STORE_KIND = 'supabase';

export const store = {
  kind: STORE_KIND,

  async listMemories(owner) {
    const { data, error } = await supabase
      .from('memories')
      .select('*')
      .eq('owner', owner)
      .order('updated', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(memRow);
  },

  async upsertMemory(owner, m) {
    const now = Date.now();
    const { data, error } = await supabase
      .from('memories')
      .upsert({
        id: m.id,
        owner,
        type: m.type ?? 'fact',
        mkey: m.key ?? '',
        value: m.value ?? '',
        confidence: m.confidence ?? 0.7,
        source: m.sourceConversationId ?? null,
        created: m.createdAt ?? now,
        updated: now,
        accessed: now,
      })
      .select()
      .single();
    if (error) throw error;
    return memRow(data);
  },

  async getMemory(owner, id) {
    const { data, error } = await supabase
      .from('memories')
      .select('*')
      .eq('id', id)
      .eq('owner', owner)
      .maybeSingle();
    if (error) throw error;
    return data ? memRow(data) : null;
  },

  async patchMemory(owner, id, patch) {
    const { data, error } = await supabase
      .from('memories')
      .update({
        mkey: patch.key,
        value: patch.value,
        updated: Date.now(),
        accessed: Date.now(),
      })
      .eq('id', id)
      .eq('owner', owner)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data ? memRow(data) : null;
  },

  async deleteMemory(owner, id) {
    const { error } = await supabase.from('memories').delete().eq('id', id).eq('owner', owner);
    if (error) throw error;
  },

  async createDoc(owner, title, text) {
    const id = crypto.randomUUID();
    const chunks = chunkText(text);
    const now = Date.now();
    const { error: docErr } = await supabase.from('docs').insert({ id, owner, title, created: now });
    if (docErr) throw docErr;

    if (chunks.length > 0) {
      const rows = chunks.map((c, i) => ({ doc: id, idx: i, text: c, owner }));
      const { error: chunkErr } = await supabase.from('chunks').insert(rows);
      if (chunkErr) throw chunkErr;
    }
    return { id, title, chunks: chunks.length };
  },

  async listDocs(owner) {
    const { data: docs, error: docErr } = await supabase
      .from('docs')
      .select('id, title, created')
      .eq('owner', owner)
      .order('created', { ascending: false });
    if (docErr) throw docErr;

    const { data: counts, error: countErr } = await supabase
      .from('chunks')
      .select('doc')
      .in('doc', (docs ?? []).map((d) => d.id));
    if (countErr) throw countErr;

    const nByDoc = new Map();
    for (const c of counts ?? []) {
      nByDoc.set(c.doc, (nByDoc.get(c.doc) ?? 0) + 1);
    }
    return (docs ?? []).map((d) => ({
      id: d.id,
      title: d.title,
      created: d.created,
      chunks: nByDoc.get(d.id) ?? 0,
    }));
  },

  async deleteDoc(owner, docId) {
    const { data, error } = await supabase
      .from('docs')
      .delete()
      .eq('id', docId)
      .eq('owner', owner)
      .select();
    if (error) throw error;
    await supabase.from('chunks').delete().eq('doc', docId);
    return (data ?? []).length > 0;
  },

  async searchChunks(owner, query, limit = 3) {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const orClause = terms.map((t) => `text.ilike.%${t}%`).join(',');
    const { data, error } = await supabase
      .from('chunks')
      .select('doc, idx, text')
      .eq('owner', owner)
      .or(orClause)
      .limit(limit);
    if (error) throw error;
    return this.withTitles(owner, data ?? []);
  },

  async withTitles(owner, rows) {
    const { data: docs } = await supabase.from('docs').select('id, title').eq('owner', owner);
    const titles = new Map((docs ?? []).map((d) => [d.id, d.title]));
    return rows.map((r) => ({ doc: r.doc, idx: r.idx, text: r.text, title: titles.get(r.doc) ?? 'Note' }));
  },

  async saveToken(token, username) {
    const { error } = await supabase.from('tokens').upsert({
      token,
      username,
      created: Date.now(),
    });
    if (error) throw error;
  },

  async userForToken(token) {
    if (!token) return null;
    const { data, error } = await supabase
      .from('tokens')
      .select('username, created')
      .eq('token', token)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (Date.now() - data.created > 30 * 86400000) {
      await supabase.from('tokens').delete().eq('token', token);
      return null;
    }
    return data.username;
  },
};

function memRow(r) {
  return {
    id: r.id,
    type: r.type,
    key: r.mkey,
    value: r.value,
    confidence: r.confidence,
    sourceConversationId: r.source ?? undefined,
    createdAt: r.created,
    updatedAt: r.updated,
    lastAccessedAt: r.accessed,
  };
}

export function chunkText(text, max = 600) {
  const paras = String(text ?? '')
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  let cur = '';
  const push = (c) => {
    if (!c) return;
    if (c.length > max * 1.5) {
      for (let i = 0; i < c.length; i += max) out.push(c.slice(i, i + max).trim());
    } else {
      out.push(c);
    }
  };
  for (const p of paras) {
    const next = cur ? `${cur}\n\n${p}` : p;
    if (next.length <= max || !cur) cur = next;
    else {
      push(cur);
      cur = p;
    }
  }
  push(cur);
  return out.filter(Boolean);
}

export function queryTerms(query, min = 3) {
  const words = String(query ?? '')
    .toLowerCase()
    .match(/[a-z0-9\u0900-\u097f]{2,}/giu);
  if (!words) return [];
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (w.length >= min && !seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out.slice(0, 10);
}

// -- kept for auth/tools modules --

export function parseUsers() {
  const raw = process.env.USERS ?? '';
  const out = new Map();
  for (const pair of raw.split(',')) {
    const i = pair.indexOf(':');
    if (i <= 0) continue;
    const user = pair.slice(0, i).trim();
    const pass = pair.slice(i + 1);
    if (user && pass) out.set(user, pass);
  }
  return out;
}

function sha(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}

export function verifyUser(users, username, password) {
  const expected = users.get(username);
  if (!expected || typeof password !== 'string') return false;
  const a = sha(password);
  const b = sha(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function issueToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function loadFileUsers() {
  const p = path.join(process.cwd(), 'data', 'users.json');
  try {
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function addFileUser(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const all = loadFileUsers().filter((u) => u.username !== username);
  all.push({ username, salt, hash, created: Date.now() });
  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'data', 'users.json'), JSON.stringify(all));
}

export function verifyFileUser(username, password) {
  const u = loadFileUsers().find((x) => x.username === username);
  if (!u || typeof password !== 'string') return false;
  try {
    const h = crypto.scryptSync(password, u.salt, 64);
    const e = Buffer.from(u.hash, 'hex');
    return h.length === e.length && crypto.timingSafeEqual(h, e);
  } catch {
    return false;
  }
}

export function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function saveMemoryVec(id, vec) { /* noop for now — vectors table later */ }
export function saveChunkVecs(doc, pairs) { /* noop for now — vectors table later */ }
export function allMemoryVecs(owner) { return []; }
export function allChunkVecs(owner) { return []; }

export function chunkTextExport(t) { return chunkText(t); }
