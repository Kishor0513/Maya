/**
 * Maya persistent storage — sqlite when available, JSON files otherwise.
 * Owns memories, documents (+FTS chunks for RAG), and auth tokens.
 * No dependencies. Data lives in DATA_DIR (default ./data).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data');

let sqliteNs = null;
try {
  sqliteNs = await import('node:sqlite');
} catch {
  sqliteNs = null; // older Node → JSON fallback below
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(name, fallback) {
  try {
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  ensureDir();
  const tmp = path.join(DATA_DIR, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, path.join(DATA_DIR, name));
}

/** Split prose into retrievable chunks (~600 chars, paragraph-aware). */
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

/** Words usable for FTS / overlap scoring (latin + Devanagari). */
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

// ─── sqlite backend ──────────────────────────────────────────────────────────

function openDb() {
  if (!sqliteNs) return null;
  try {
    const Ctor = sqliteNs.DatabaseSync ?? sqliteNs.Database;
    if (typeof Ctor !== 'function') return null;
    ensureDir();
    const db = new Ctor(path.join(DATA_DIR, 'maya.db'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, owner TEXT NOT NULL, type TEXT, mkey TEXT, value TEXT, confidence REAL, source TEXT, created INTEGER, updated INTEGER, accessed INTEGER);
      CREATE INDEX IF NOT EXISTS idx_mem_owner ON memories(owner);
      CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS chunks(doc TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(doc UNINDEXED, idx UNINDEXED, owner UNINDEXED, text);
      CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, username TEXT NOT NULL, created INTEGER);
    `);
    return db;
  } catch {
    return null;
  }
}

const db = openDb();
export const STORE_KIND = db ? 'sqlite' : 'json';

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

export const store = {
  kind: STORE_KIND,

  // — memories —
  listMemories(owner) {
    if (db) {
      return db
        .prepare('SELECT * FROM memories WHERE owner = ? ORDER BY updated DESC')
        .all(owner)
        .map(memRow);
    }
    return readJson('memories.json', []).filter((m) => (m.owner ?? 'local') === owner);
  },

  upsertMemory(owner, m) {
    const now = Date.now();
    if (db) {
      const prev = db.prepare('SELECT * FROM memories WHERE id = ?').get(m.id);
      db.prepare(
        `INSERT INTO memories(id, owner, type, mkey, value, confidence, source, created, updated, accessed)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type=excluded.type, mkey=excluded.mkey, value=excluded.value,
           confidence=excluded.confidence, source=excluded.source, updated=excluded.updated, accessed=excluded.accessed`,
      ).run(
        m.id, owner, m.type ?? 'fact', m.key ?? '', m.value ?? '', m.confidence ?? 0.7,
        m.sourceConversationId ?? null, prev?.created ?? m.createdAt ?? now, now, now,
      );
      return db.prepare('SELECT * FROM memories WHERE id = ?').get(m.id) && this.getMemory(owner, m.id);
    }
    const all = readJson('memories.json', []);
    const i = all.findIndex((x) => x.id === m.id);
    const full = {
      id: m.id, type: m.type ?? 'fact', key: m.key ?? '', value: m.value ?? '',
      confidence: m.confidence ?? 0.7, sourceConversationId: m.sourceConversationId,
      owner, createdAt: i >= 0 ? all[i].createdAt : (m.createdAt ?? now),
      updatedAt: now, lastAccessedAt: now,
    };
    if (i >= 0) all[i] = full;
    else all.unshift(full);
    writeJson('memories.json', all);
    return full;
  },

  getMemory(owner, id) {
    if (db) {
      const r = db.prepare('SELECT * FROM memories WHERE id = ? AND owner = ?').get(id, owner);
      return r ? memRow(r) : null;
    }
    return readJson('memories.json', []).find((m) => m.id === id && (m.owner ?? 'local') === owner) ?? null;
  },

  patchMemory(owner, id, patch) {
    if (db) {
      const r = db.prepare('SELECT * FROM memories WHERE id = ? AND owner = ?').get(id, owner);
      if (!r) return null;
      db.prepare('UPDATE memories SET mkey = ?, value = ?, updated = ?, accessed = ? WHERE id = ?').run(
        patch.key ?? r.mkey, patch.value ?? r.value, Date.now(), Date.now(), id,
      );
      return this.getMemory(owner, id);
    }
    const all = readJson('memories.json', []);
    const m = all.find((x) => x.id === id && (x.owner ?? 'local') === owner);
    if (!m) return null;
    if (patch.key !== undefined) m.key = patch.key;
    if (patch.value !== undefined) m.value = patch.value;
    m.updatedAt = Date.now();
    writeJson('memories.json', all);
    return m;
  },

  deleteMemory(owner, id) {
    if (db) {
      db.prepare('DELETE FROM memories WHERE id = ? AND owner = ?').run(id, owner);
      return;
    }
    writeJson(
      'memories.json',
      readJson('memories.json', []).filter((m) => !(m.id === id && (m.owner ?? 'local') === owner)),
    );
  },

  // — documents + RAG —
  createDoc(owner, title, text) {
    const id = crypto.randomUUID();
    const chunks = chunkText(text);
    const now = Date.now();
    if (db) {
      db.prepare('INSERT INTO docs(id, owner, title, created) VALUES(?, ?, ?, ?)').run(id, owner, title, now);
      const insChunk = db.prepare('INSERT INTO chunks(doc, idx, text) VALUES(?, ?, ?)');
      const insFts = db.prepare('INSERT INTO chunks_fts(doc, idx, owner, text) VALUES(?, ?, ?, ?)');
      chunks.forEach((c, i) => {
        insChunk.run(id, i, c);
        insFts.run(id, i, owner, c);
      });
    } else {
      const all = readJson('docs.json', []);
      all.unshift({ id, owner, title, created: now, chunks });
      writeJson('docs.json', all);
    }
    return { id, title, chunks: chunks.length };
  },

  listDocs(owner) {
    if (db) {
      const docs = db.prepare('SELECT id, title, created FROM docs WHERE owner = ? ORDER BY created DESC').all(owner);
      const count = db.prepare('SELECT doc, COUNT(*) AS n FROM chunks GROUP BY doc').all();
      const nByDoc = new Map(count.map((r) => [r.doc, r.n]));
      return docs.map((d) => ({ id: d.id, title: d.title, created: d.created, chunks: nByDoc.get(d.id) ?? 0 }));
    }
    return readJson('docs.json', [])
      .filter((d) => (d.owner ?? 'local') === owner)
      .map((d) => ({ id: d.id, title: d.title, created: d.created, chunks: d.chunks.length }));
  },

  deleteDoc(owner, docId) {
    if (db) {
      const d = db.prepare('SELECT id FROM docs WHERE id = ? AND owner = ?').get(docId, owner);
      if (!d) return false;
      db.prepare('DELETE FROM docs WHERE id = ?').run(docId);
      db.prepare('DELETE FROM chunks WHERE doc = ?').run(docId);
      db.prepare("DELETE FROM chunks_fts WHERE doc = ?").run(docId);
      return true;
    }
    const all = readJson('docs.json', []);
    const kept = all.filter((d) => !(d.id === docId && (d.owner ?? 'local') === owner));
    if (kept.length === all.length) return false;
    writeJson('docs.json', kept);
    return true;
  },

  searchChunks(owner, query, limit = 3) {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    if (db) {
      try {
        const match = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
        const rows = db
          .prepare(`SELECT doc, idx, text FROM chunks_fts WHERE text MATCH ? AND owner = ? ORDER BY rank LIMIT ?`)
          .all(match, owner, limit);
        if (rows.length > 0) return this.withTitles(owner, rows);
      } catch {
        /* FTS syntax edge → fall through to LIKE */
      }
      const like = `%${terms[0]}%`;
      const rows = db
        .prepare(
          `SELECT c.doc AS doc, c.idx AS idx, c.text AS text FROM chunks c
           JOIN docs d ON d.id = c.doc WHERE d.owner = ? AND c.text LIKE ? LIMIT ?`,
        )
        .all(owner, like, limit);
      return this.withTitles(owner, rows);
    }
    // JSON fallback: word-overlap scoring.
    const docs = readJson('docs.json', []).filter((d) => (d.owner ?? 'local') === owner);
    const scored = [];
    for (const d of docs) {
      const titles = d.title;
      d.chunks.forEach((text, idx) => {
        const hay = `${titles} ${text}`.toLowerCase();
        let s = 0;
        for (const t of terms) if (hay.includes(t)) s += 1;
        if (s > 0) scored.push({ doc: d.id, idx, text, title: titles, score: s });
      });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ doc, idx, text, title }) => ({ doc, idx, text, title }));
  },

  withTitles(owner, rows) {
    const titles = new Map(
      this.listDocs(owner).map((d) => [d.id, d.title]),
    );
    return rows.map((r) => ({ doc: r.doc, idx: r.idx, text: r.text, title: titles.get(r.doc) ?? 'Note' }));
  },

  // — auth tokens —
  saveToken(token, username) {
    if (db) {
      db.prepare('INSERT OR REPLACE INTO tokens(token, username, created) VALUES(?, ?, ?)').run(token, username, Date.now());
      return;
    }
    const all = readJson('tokens.json', {});
    all[token] = { username, created: Date.now() };
    writeJson('tokens.json', all);
  },

  userForToken(token) {
    if (!token) return null;
    if (db) {
      const r = db.prepare('SELECT username FROM tokens WHERE token = ?').get(token);
      return r ? r.username : null;
    }
    const all = readJson('tokens.json', {});
    return all[token]?.username ?? null;
  },
};

// ─── users (home-grade; production wants OAuth/DB) ───────────────────────────
// USERS="alice:s3cret,bob:other" — plaintext shared-household file.
// Compared as sha256 hashes with timingSafeEqual (no length oracle).

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
