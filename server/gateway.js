/**
 * Maya reference backend — pluggable AI brain (Google Gemini / local).
 *
 * Zero dependencies, Node 18+. Forwards Maya's backend contract onto any
 * OpenAI-compatible chat-completions endpoint, and keeps a tiny in-memory
 * memory store so the Memory panel works end-to-end.
 * (Swap the Map for a real DB before production.)
 *
 * Run (Google Gemini — free key from aistudio.google.com → Get API key):
 *   UPSTREAM_KEY=AIzaSy_xxx UPSTREAM_MODEL=gemini-3.6-flash node server/gateway.js
 *   # or: set -a; source server/.env; set +a; node server/gateway.js
 *
 * Run (local Ollama / vLLM — no key):
  *   UPSTREAM_BASE=http://localhost:11434/v1 UPSTREAM_MODEL=qwen2.5:3b node server/gateway.js
 *
 * Then in Maya: Settings → AI Provider → pick the matching backend,
 * endpoint "/api" (Vite proxies it here in dev), model = your model ID.
 *
 * Env:
  *   UPSTREAM_BASE  brain endpoint (Gemini OpenAI-compat, Groq, Ollama, or local)
 *   UPSTREAM_KEY   server-side key, sent as Bearer or x-goog-api-key (auto)
 *   UPSTREAM_MODEL default model when the client doesn't specify one
 *   UPSTREAM2..5_BASE/KEY/MODEL/AUTH  failover spares, e.g. Groq free tier:
 *     UPSTREAM2_BASE=https://api.groq.com/openai/v1
 *     UPSTREAM2_KEY=gsk_paste_yours_here
 *     UPSTREAM2_MODEL=llama-3.3-70b-versatile
 *   USERS      optional multi-user gate, e.g. USERS="alice:pw1,bob:pw2"
 *              (home-grade; empty = open single-user mode)
 *   COMPUTER_TOOLS=true   enable local computer control (screenshots, shell,
 *              apps, workspace files). Off by default — opt in deliberately.
 *   MAYA_WORKSPACE=...    workspace dir for computer tools (default ~/Documents/Maya)
 *   DATA_DIR   storage dir for sqlite/JSON (default ./data)
 *   PORT       default 8787
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
// NOTE: store is imported dynamically AFTER loadEnvFile() below — static
// imports evaluate first, which would read env before .env is loaded.
loadEnvFile();
const {
  store,
  STORE_KIND,
  parseUsers,
  verifyUser,
  issueToken,
  verifyFileUser,
  chunkText,
  cosineSim,
} = await import('./store_supabase.js');

const USERS = parseUsers();
const authEnabled = USERS.size > 0;

const PORT = Number(process.env.PORT ?? 8787);

// Auto-load server/.env (repo server/ dir or CWD) so `npm start` just works.
// Real environment variables always win — file values only fill gaps.
function loadEnvFile() {
  try {
    const candidates = [
      path.join(process.cwd(), 'server', '.env'),
      path.join(process.cwd(), '.env'),
    ];
    for (const file of candidates) {
      let text;
      try {
        if (!fs.existsSync(file)) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i <= 0) continue;
        const k = t.slice(0, i).trim();
        let v = t.slice(i + 1).trim();
        if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
          v = v.slice(1, -1);
        }
        if (k && !(k in process.env)) process.env[k] = v;
      }
      break;
    }
  } catch {
    /* env loading never breaks boot */
  }
}
// Optional shared secret: when set, every /api/* request must carry it as
// the x-gateway-token header, otherwise 401. Stops strangers from spending
// your upstream quota once the gateway is public. (No user accounts here —
// this is a shared-household/small-team gate, not bulletproof auth.)
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? '';
// Optional CORS lockdown: when set, only this origin is allowed.
// Default (empty) reflects the caller, which is fine for local dev.
const ALLOWED_ORIGIN = (() => {
  const v = (process.env.ALLOWED_ORIGIN ?? '').trim().replace(/\/$/, '');
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
})();
const UPSTREAM_BASE = (
  process.env.UPSTREAM_BASE ??
  'https://generativelanguage.googleapis.com/v1beta/openai'
).replace(/\/$/, '');
const UPSTREAM_MODEL =
  process.env.UPSTREAM_MODEL ?? 'gemini-3.6-flash';
const UPSTREAM_KEY = process.env.UPSTREAM_KEY ?? '';
// All OpenAI-compatible endpoints (Gemini /openai, Groq, Ollama, vLLM)
// authenticate with a Bearer token. Set UPSTREAM_AUTH=x-goog-api-key only
// when talking to Google's native (non-OpenAI) endpoints.
const UPSTREAM_AUTH = process.env.UPSTREAM_AUTH ?? 'bearer';

// Failover chain: primary UPSTREAM_* plus numbered UPSTREAM2..5_* spares,
// then a built-in keyless fallback. A throttled/dead provider rolls to the
// next link inside the same request — the app only sees an error when every
// link fails. Add a spare like: UPSTREAM2_BASE=https://api.groq.com/openai/v1
// UPSTREAM2_KEY=gsk_... UPSTREAM2_MODEL=llama-3.3-70b-versatile
function buildChain() {
  const chain = [
    { base: UPSTREAM_BASE, key: UPSTREAM_KEY, model: UPSTREAM_MODEL, auth: UPSTREAM_AUTH, name: 'primary' },
  ];
  for (let i = 2; i <= 5; i++) {
    const base = (process.env[`UPSTREAM${i}_BASE`] ?? '').replace(/\/$/, '');
    if (!base) continue;
    chain.push({
      base,
      key: process.env[`UPSTREAM${i}_KEY`] ?? '',
      model: process.env[`UPSTREAM${i}_MODEL`] ?? 'openai',
      auth: process.env[`UPSTREAM${i}_AUTH`] ?? 'bearer',
      name: `upstream${i}`,
    });
  }
  // Last resort: keyless public inference (slower, fair-use limits).
  chain.push({
    base: 'https://text.pollinations.ai/openai',
    key: '',
    model: 'openai',
    auth: 'bearer',
    name: 'pollinations-fallback',
  });
  return chain;
}
const UPSTREAMS = buildChain();
let lastServedBy = 'none';

function entryNeedsKey(up) {
  return up.base.includes('googleapis.com') && !up.key;
}
// Local upstreams need no key; googleapis.com always does.
const needsAuth = UPSTREAM_BASE.includes('googleapis.com');

function authHeadersFor(up) {
  if (!up.key) return {};
  if (up.auth === 'x-goog-api-key') return { 'x-goog-api-key': up.key };
  return { Authorization: `Bearer ${up.key}` };
}

function authHeaders() {
  return authHeadersFor(UPSTREAMS[0]);
}
const MAX_BODY = 1_000_000;

// Local computer control (macOS-first). Disabled unless COMPUTER_TOOLS=true.
// The gateway enforces the hard safety floor (blocklist below); the frontend
// adds per-action user approval on top. Workspace jail applies to file ops.
const COMPUTER_ENABLED = process.env.COMPUTER_TOOLS === 'true';

function workspaceRoot() {
  const w = process.env.MAYA_WORKSPACE || path.join(os.homedir(), 'Documents', 'Maya');
  fs.mkdirSync(w, { recursive: true });
  return w;
}

/** Resolve p inside the workspace; null on jail escape. */
function jail(p) {
  const root = workspaceRoot();
  const full = path.normalize(path.join(root, String(p ?? '')));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/** Authoritative server-side blocklist: never executed, even if approved. */
const BLOCKED_CMD = [
  /\brm\s+-[a-z]*r/i,
  /\bsudo\b/i,
  /(^|[;&|])\s*su\b/i,
  /\b(ssh|scp|sftp|rsync)\b/i,
  /curl[\s\S]*\|\s*(sh|bash)/i,
  /wget[\s\S]*\|\s*(sh|bash)/i,
  /:\(\)\s*\{/,
  /\bdd\b[\s\S]*of=\/dev/i,
  /\bmkfs\b/i,
  /\bsecurity\b\s+(dump|find-generic-password|delete-generic-password)/i,
  /keychain/i,
];

function isBlockedCommand(cmd) {
  return BLOCKED_CMD.some((re) => re.test(cmd));
}

function runShell(cmd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    exec(
      cmd,
      { cwd: workspaceRoot(), timeout: timeoutMs, maxBuffer: 1024 * 100, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout: String(stdout ?? '').slice(0, 20000),
          stderr: String(stderr ?? '').slice(0, 5000),
          timedOut: !!err && err.killed === true,
        });
      },
    );
  });
}

// Rate limiting: per-IP sliding windows (no deps). Health stays open;
// login is strict (brute force), everything else generous.
const RATE_WINDOW_MS = 60000;
const RATE_API_MAX = 120;
const RATE_LOGIN_MAX = 10;
const rateHits = new Map();
let rateSweepAt = 0;

function rateOk(key, max) {
  const now = Date.now();
  if (now - rateSweepAt > RATE_WINDOW_MS) {
    rateSweepAt = now;
    for (const [k, arr] of rateHits) {
      const fresh = arr.filter((t) => now - t < RATE_WINDOW_MS);
      if (fresh.length > 0) rateHits.set(k, fresh);
      else rateHits.delete(k);
    }
  }
  const arr = (rateHits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= max) return false;
  arr.push(now);
  rateHits.set(key, arr);
  return true;
}

// Persistent store (sqlite when available, JSON files otherwise). Replaces
// the old in-memory Map — memories and documents survive restarts.
function bearerToken(req) {
  const h = req.headers.authorization ?? '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Owner id for scoping data. Open mode (no USERS) → shared 'local'. */
async function ownerOf(req) {
  if (!authEnabled) return 'local';
  return await store.userForToken(bearerToken(req)) ?? 'local';
}

// Optional: serve the built app (npm run build → dist/) from the SAME origin
// as the API, so the browser needs no Vite, no proxy, and no CORS.
// Set SERVE_DIR=./dist and run node from the repo root.
const SERVE_DIR = process.env.SERVE_DIR ? path.resolve(process.env.SERVE_DIR) : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStatic(url, req, res) {
  if (!SERVE_DIR || req.method !== 'GET') return false;
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.normalize(path.join(SERVE_DIR, rel));
  if (file !== SERVE_DIR && !file.startsWith(SERVE_DIR + path.sep)) return false;
  try {
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(rel)) return false; // real missing asset → 404
      file = path.join(SERVE_DIR, 'index.html'); // SPA fallback
      if (!fs.existsSync(file)) return false;
    }
    const body = fs.readFileSync(file);
    const mime = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function corsHeaders(req) {
  const origin = ALLOWED_ORIGIN || req.headers.origin || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function json(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('bad-json'));
      }
    });
    req.on('error', reject);
  });
}

/** Accept Maya's { messages } shape (and CustomProvider's { message }). */
function toMessages(body) {
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const out = [];
    for (const m of body.messages.slice(-20)) {
      if (!m || (typeof m.content !== 'string' && !Array.isArray(m.content))) continue;
      const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
      if (typeof m.content === 'string') {
        const content = m.content.slice(0, 8000);
        if (content.trim()) out.push({ role, content });
        continue;
      }
      // OpenAI multipart (text + image_url) — sanitize lightly, forward.
      const parts = m.content
        .filter((p) => p && typeof p === 'object')
        .slice(0, 5)
        .map((p) => {
          if (p.type === 'text') return { type: 'text', text: String(p.text ?? '').slice(0, 8000) };
          if (p.type === 'image_url') {
            const url = p.image_url && typeof p.image_url.url === 'string' ? p.image_url.url.slice(0, 500000) : '';
            return url ? { type: 'image_url', image_url: { url } } : null;
          }
          return null;
        })
        .filter(Boolean);
      if (parts.length > 0) out.push({ role, content: parts });
    }
    if (out.length > 0) return out;
  }
  if (typeof body.message === 'string' && body.message.trim()) {
    return [{ role: 'user', content: body.message.slice(0, 8000) }];
  }
  return null;
}

function pickModel(body) {
  return typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : UPSTREAM_MODEL;
}

async function callHf(messages, clientModel, stream) {
  let lastStatus = 0;
  for (const [i, up] of UPSTREAMS.entries()) {
    if (entryNeedsKey(up)) continue;
    // First link honors the client's model choice; spares use their own
    // (slugs differ per vendor).
    const model = i === 0 ? clientModel || up.model : up.model;
    try {
      const res = await fetch(`${up.base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeadersFor(up),
        },
        body: JSON.stringify({ model, messages, stream }),
      });
      if (res.ok) {
        if (i > 0) console.log(`[chat] failover → ${up.name} (${model})`);
        lastServedBy = `${up.name}:${model}`;
        return res;
      }
      lastStatus = res.status;
      await res.text().catch(() => undefined);
      console.log(`[chat] ${up.name} → ${res.status}, trying next`);
    } catch (err) {
      console.log(`[chat] ${up.name} unreachable, trying next`);
    }
  }
  // Shape matches a real error response so callers keep working —
  // notably, upstream 429s still surface as rate-limited downstream.
  return new Response(JSON.stringify({ error: 'all upstreams failed' }), {
    status: lastStatus || 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

const WX_CODE = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'light snow showers', 86: 'snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};

/** Keyless web search: Wikipedia first, DuckDuckGo instant-answer as backup. */
async function toolWebSearch(query) {
  const q = String(query ?? '').slice(0, 200).trim();
  if (!q) return { results: [] };
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=5&origin=*`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Maya/1.0 (personal assistant)' } });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const hits = data?.query?.search ?? [];
      const results = hits.slice(0, 5).map((h) => ({
        title: h.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(h.title).replace(/ /g, '_'))}`,
        snippet: String(h.snippet ?? '').replace(/<[^>]+>/g, ''),
      }));
      if (results.length > 0) return { results };
    }
  } catch {
    /* fall through to DDG */
  }
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
    const ddg = await (await fetch(url, { headers: { 'User-Agent': 'Maya/1.0' } })).json();
    if (ddg?.AbstractText) {
      return { results: [{ title: ddg.Heading || q, url: ddg.AbstractURL || '', snippet: ddg.AbstractText }] };
    }
  } catch {
    /* unavailable */
  }
  return { results: [] };
}

/** Keyless weather via Open-Meteo (geocoding + forecast, no key). */
async function toolWeather(args) {
  const a = args && typeof args === 'object' ? args : {};
  let lat = Number(a.lat);
  let lon = Number(a.lon);
  let place = typeof a.location === 'string' ? a.location.slice(0, 80) : '';
  if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && place) {
    const g = await (
      await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&format=json`)
    ).json().catch(() => null);
    const first = g?.results?.[0];
    if (!first) return { error: 'place not found' };
    lat = first.latitude;
    lon = first.longitude;
    place = `${first.name}${first.country ? `, ${first.country}` : ''}`;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: 'need a location' };
  const w = await (
    await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`,
    )
  ).json();
  if (!w?.current) return { error: 'weather unavailable' };
  return {
    place: place || `${lat.toFixed(2)},${lon.toFixed(2)}`,
    temp: w.current.temperature_2m,
    condition: WX_CODE[w.current.weather_code] ?? 'unknown',
    high: w.daily?.temperature_2m_max?.[0],
    low: w.daily?.temperature_2m_min?.[0],
    humidity: w.current.relative_humidity_2m,
    wind: w.current.wind_speed_10m,
  };
}

function splitSentences(text, max = 180) {
  const parts = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length <= max) out.push(p);
    else for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
  }
  return out;
}

/** ElevenLabs: lifelike voice (Rachel = natural female, default). */
async function elevenLabsTts(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 2500);
  if (!clean) return { audios: [] };
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY ?? '',
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: clean,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  );
  if (!res.ok) throw new Error(`elevenlabs ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error('elevenlabs empty audio');
  return { audios: [buf.toString('base64')] };
}

/** Gateway voice: ElevenLabs when configured, else keyless sentence MP3s. */
async function toolTts(text) {
  // Realistic voice first: ElevenLabs (single full-reply synthesis =
  // better prosody than sentence chunks). Falls through on any failure.
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      return await elevenLabsTts(text);
    } catch (err) {
      console.log(`[tts] elevenlabs failed, falling back: ${String(err).slice(0, 120)}`);
    }
  }
  const parts = splitSentences(text).slice(0, 8);
  if (parts.length === 0) return { audios: [] };
  const audios = [];
  for (const p of parts) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(p)}&tl=en&client=tw-ob`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) throw new Error('tts empty');
    audios.push(buf.toString('base64'));
  }
  return { audios };
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

/** RAG: FTS hits blended with embedding-cosine hits (owner-scoped). */
async function injectNotes(owner, messages) {
  try {
    const q = lastUserText(messages);
    if (!q || q.length < 4) return messages;
    const fts = await store.searchChunks(owner, q, 3);
    let extra = [];
    try {
      const qv = await embedOne(q);
      if (qv) {
        const seen = new Set(fts.map((h) => `${h.doc}:${h.idx}`));
        const ranked = store
          .allChunkVecs(owner)
          .map((c) => ({ ...c, s: cosineSim(qv, c.vec) }))
          .filter((c) => c.s > 0.35)
          .sort((a, b) => b.s - a.s)
          .slice(0, 3)
          .filter((c) => !seen.has(`${c.doc}:${c.idx}`));
        extra = await store.withTitles(owner, ranked);
      }
    } catch {
      /* embeddings unavailable — FTS alone */
    }
    const hits = [...fts, ...extra].slice(0, 5);
    if (hits.length === 0) return messages;
    const note = `Relevant notes from the user's saved documents (use them if helpful, never mention this block):\n${hits
      .map((h) => `- [${h.title}] ${String(h.text).slice(0, 500)}`)
      .join('\n')}`;
    const out = [...messages];
    const sysIdx = out.findIndex((m) => m && m.role === 'system');
    if (sysIdx >= 0) out.splice(sysIdx + 1, 0, { role: 'system', content: note });
    else out.unshift({ role: 'system', content: note });
    return out;
  } catch {
    return messages;
  }
}

/** Native Gemini embeddings (the OpenAI-compat surface has no embed op). */
async function embedOne(text) {
  if (!UPSTREAM_KEY || !UPSTREAM_BASE.includes('googleapis.com')) return null;
  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': UPSTREAM_KEY },
        body: JSON.stringify({ content: { parts: [{ text: String(text ?? '').slice(0, 4000) }] } }),
      },
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const v = data?.embedding?.values;
    if (!Array.isArray(v)) return null;
    const nums = v.map(Number).filter(Number.isFinite);
    return nums.length > 10 ? nums : null;
  } catch {
    return null;
  }
}

/** Fire-and-forget vector indexing after a write (never fails the request). */
function indexMemoryVec(owner, saved) {
  void (async () => {
    try {
      const v = await embedOne(`${saved.key ?? ''} ${saved.value ?? ''}`);
      if (v) await store.saveMemoryVec(saved.id, v);
    } catch {
      /* embeddings unavailable — TF-IDF/FTS still work */
    }
  })();
}

async function handleChat(req, res) {
  if (!UPSTREAMS.some((u) => !entryNeedsKey(u))) return json(res, 503, { error: 'no usable brain — set UPSTREAM_KEY or configure an upstream' });
  let body;
  try {
    body = await readJson(req);
  } catch {
    return json(res, 400, { error: 'invalid JSON body' });
  }
  const messages = await injectNotes(await ownerOf(req), toMessages(body));
  if (!messages) return json(res, 400, { error: 'expected { messages } or { message }' });
  const model = pickModel(body);
  const t0 = Date.now();
  let hf;
  try {
    hf = await callHf(messages, model, false);
  } catch (err) {
    console.log(`[chat] model=${model} msgs=${messages.length} → unreachable (${Date.now() - t0}ms)`);
    return json(res, 502, { error: 'hf-unreachable', detail: String(err).slice(0, 200) });
  }
  if (!hf.ok) {
    const detail = await hf.text().catch(() => '');
    console.log(`[chat] model=${model} msgs=${messages.length} → upstream ${hf.status} (${Date.now() - t0}ms) :: ${detail.slice(0, 160)}`);
    if (hf.status === 429) {
      const m = detail.match(/retry in ([\d.]+)s/i);
      return json(res, 429, {
        error: 'rate-limited',
        retryAfter: m ? Math.max(1, Math.ceil(Number(m[1]))) : 60,
      });
    }
    return json(res, 502, { error: 'hf-error', status: hf.status, detail: detail.slice(0, 500) });
  }
  const data = await hf.json().catch(() => null);
  const text = data?.choices?.[0]?.message?.content ?? '';
  console.log(`[chat] model=${model} msgs=${messages.length} → 200 (${Date.now() - t0}ms, ${text.length} chars)`);
  return json(res, 200, { text });
}

async function handleChatStream(req, res) {
  const headers = {
    ...corsHeaders(req),
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };
  if (!UPSTREAMS.some((u) => !entryNeedsKey(u))) {
    res.writeHead(503, headers);
    res.write(`data: ${JSON.stringify({ error: 'no usable brain — set UPSTREAM_KEY or configure an upstream' })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    res.writeHead(400, headers);
    return res.end();
  }
  // Body must be fully read before we can start the SSE response.
  const messages = await injectNotes(await ownerOf(req), toMessages(body));
  if (!messages) {
    res.writeHead(400, headers);
    return res.end();
  }
  let hf;
  const model = pickModel(body);
  const t0 = Date.now();
  try {
    hf = await callHf(messages, model, true);
  } catch {
    console.log(`[stream] model=${model} → unreachable`);
    res.writeHead(502, headers);
    return res.end();
  }
  if (!hf.ok || !hf.body) {
    console.log(`[stream] model=${model} → upstream ${hf ? hf.status : 'no-body'}`);
    res.writeHead(hf && hf.status === 429 ? 429 : 502, headers);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(200, headers);
  const reader = hf.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let closed = false;
  req.on('close', () => {
    closed = true;
    reader.cancel().catch(() => undefined);
  });
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (done || closed) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        console.log(`[stream] model=${model} → 200 (${Date.now() - t0}ms)`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content ?? '';
        if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      } catch {
        /* HF keep-alive comment — ignore */
      }
    }
  }
  if (!closed) {
    console.log(`[stream] model=${model} → 200, client held open (${Date.now() - t0}ms)`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    console.log(`[stream] model=${model} → client disconnected early (${Date.now() - t0}ms)`);
  }
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://local');
  if (url.pathname.startsWith('/api/')) console.log(`[req] ${req.method} ${url.pathname}`);
  const headers = corsHeaders(req);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (
    GATEWAY_TOKEN &&
    url.pathname.startsWith('/api/') &&
    req.headers['x-gateway-token'] !== GATEWAY_TOKEN
  ) {
    return json(res, 401, { error: 'unauthorized' });
  }

  // Multi-user gate (only when USERS is configured). Health + login stay open.
  if (
    authEnabled &&
    url.pathname.startsWith('/api/') &&
    url.pathname !== '/api/health' &&
    url.pathname !== '/api/login' &&
    !(await store.userForToken(bearerToken(req)))
  ) {
    return json(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const loginPath = url.pathname === '/api/login';
    if (!rateOk(`${ip}:${loginPath ? 'login' : 'api'}`, loginPath ? RATE_LOGIN_MAX : RATE_API_MAX)) {
      return json(res, 429, { error: 'rate-limited', retryAfter: 60 });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, model: UPSTREAM_MODEL, base: UPSTREAM_BASE, key: UPSTREAM_KEY ? 'set' : needsAuth ? 'missing' : 'not-needed-locally', auth: authEnabled, db: STORE_KIND, chain: UPSTREAMS.map((u) => u.name), serving: lastServedBy });
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    try {
      const body = await readJson(req);
      if (!authEnabled) return json(res, 200, { token: null, user: 'local' });
      const { username, password } = body;
      if (typeof username !== 'string' || !(verifyUser(USERS, username, password) || verifyFileUser(username, password))) {
        return json(res, 401, { error: 'invalid credentials' });
      }
      const token = issueToken();
      await store.saveToken(token, username);
      return json(res, 200, { token, user: username });
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && url.pathname === '/api/chat/stream') return handleChatStream(req, res);

  if (req.method === 'GET' && url.pathname === '/api/memories') {
    return json(res, 200, await store.listMemories(await ownerOf(req)));
  }
  if (req.method === 'POST' && url.pathname === '/api/memories') {
    try {
      const m = await readJson(req);
      if (!m || typeof m.id !== 'string') return json(res, 400, { error: 'memory needs an id' });
      const owner = await ownerOf(req);
      const saved = await store.upsertMemory(owner, m);
      indexMemoryVec(owner, saved);
      return json(res, 200, saved);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
  }
  const memMatch = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
  if (memMatch) {
    const id = decodeURIComponent(memMatch[1]);
    const owner = await ownerOf(req);
    if (req.method === 'DELETE') {
      await store.deleteMemory(owner, id);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'PATCH') {
      try {
        const patch = await readJson(req);
        const updated = await store.patchMemory(owner, id, patch);
        if (!updated) return json(res, 404, { error: 'not-found' });
        return json(res, 200, updated);
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/documents') {
    return json(res, 200, await store.listDocs(await ownerOf(req)));
  }
  if (req.method === 'POST' && url.pathname === '/api/documents') {
    try {
      const body = await readJson(req);
      const text = String(body.text ?? '').trim();
      if (!text) return json(res, 400, { error: 'empty document' });
      const title = String(body.title ?? '').trim().slice(0, 120) || text.slice(0, 40) || 'Untitled note';
      const owner = await ownerOf(req);
      const created = await store.createDoc(owner, title, text.slice(0, 20000));
      void (async () => {
        try {
          const pairs = [];
          for (const [i, c] of chunkText(text.slice(0, 20000)).entries()) {
            const v = await embedOne(c);
            if (v) pairs.push([i, v]);
          }
          if (pairs.length > 0) await store.saveChunkVecs(created.id, pairs);
        } catch {
          /* ignore — FTS covers retrieval */
        }
      })();
      return json(res, 200, created);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
  }
  const docMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (docMatch && req.method === 'DELETE') {
    const ok = await store.deleteDoc(await ownerOf(req), decodeURIComponent(docMatch[1]));
    if (!ok) return json(res, 404, { error: 'not-found' });
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/api/memories/search') {
    try {
      const q = (url.searchParams.get('q') ?? '').slice(0, 200);
      const owner = await ownerOf(req);
      const qv = await embedOne(q);
      if (!qv) return json(res, 200, []);
      const ranked = store
        .allMemoryVecs(owner)
        .map(({ id, vec }) => ({ id, s: cosineSim(qv, vec) }))
        .filter((x) => x.s > 0.3)
        .sort((a, b) => b.s - a.s)
        .slice(0, 6);
      return json(res, 200, ranked.map((x) => store.getMemory(owner, x.id)).filter(Boolean));
    } catch {
      return json(res, 200, []);
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/tools/web_search') {
    try {
      const body = await readJson(req);
      return json(res, 200, await toolWebSearch(body.query));
    } catch {
      return json(res, 502, { error: 'search unavailable' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/tools/weather') {
    try {
      const body = await readJson(req);
      const out = await toolWeather(body);
      if (out.error) return json(res, 422, out);
      return json(res, 200, out);
    } catch {
      return json(res, 502, { error: 'weather unavailable' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/tts') {
    try {
      const body = await readJson(req);
      return json(res, 200, await toolTts(body.text));
    } catch {
      return json(res, 502, { error: 'tts unavailable' });
    }
  }
  // — local computer control (gated by COMPUTER_TOOLS) —
  const computerGate = () =>
    COMPUTER_ENABLED
      ? null
      : json(res, 501, {
          error: 'computer-disabled',
          setup: 'Set COMPUTER_TOOLS=true on the gateway to enable local computer control.',
        });

  if (req.method === 'GET' && url.pathname === '/api/computer/status') {
    return json(res, 200, {
      enabled: COMPUTER_ENABLED,
      platform: process.platform,
      workspace: COMPUTER_ENABLED ? workspaceRoot() : null,
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/computer/screenshot') {
    const gate = computerGate();
    if (gate) return gate;
    if (process.platform !== 'darwin') {
      return json(res, 501, { error: 'screenshots need macOS (screencapture)' });
    }
    try {
      const tmp = path.join(os.tmpdir(), `maya-shot-${Date.now()}.jpg`);
      await new Promise((resolve, reject) => {
        execFile('screencapture', ['-x', '-t', 'jpg', tmp], (e) => (e ? reject(e) : resolve(null)));
      });
      try {
        const buf = fs.readFileSync(tmp);
        return json(res, 200, { image: `data:image/jpeg;base64,${buf.toString('base64')}` });
      } finally {
        fs.unlink(tmp, () => undefined);
      }
    } catch {
      return json(res, 502, { error: 'screenshot failed' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/computer/open') {
    const gate = computerGate();
    if (gate) return gate;
    try {
      const body = await readJson(req);
      const target = String(body.target ?? '').slice(0, 300).trim();
      if (!target) return json(res, 400, { error: 'need a target app or URL' });
      if (process.platform === 'darwin') {
        await new Promise((resolve, reject) => {
          execFile('open', [target], (e) => (e ? reject(e) : resolve(null)));
        });
        return json(res, 200, { opened: true, target });
      }
      return json(res, 501, { error: 'open needs macOS for now' });
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/computer/exec') {
    const gate = computerGate();
    if (gate) return gate;
    try {
      const body = await readJson(req);
      const command = String(body.command ?? '').slice(0, 2000);
      if (!command.trim()) return json(res, 400, { error: 'need a command' });
      if (isBlockedCommand(command)) {
        return json(res, 403, { error: 'blocked', reason: 'destructive, privileged, or exfiltration pattern' });
      }
      return json(res, 200, await runShell(command));
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/computer/files') {
    const gate = computerGate();
    if (gate) return gate;
    const full = jail(url.searchParams.get('path') ?? '');
    if (!full) return json(res, 403, { error: 'outside workspace' });
    try {
      const entries = fs.readdirSync(full, { withFileTypes: true }).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
      }));
      return json(res, 200, { path: full, entries: entries.slice(0, 200) });
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/computer/file') {
    const gate = computerGate();
    if (gate) return gate;
    const full = jail(url.searchParams.get('path') ?? '');
    if (!full) return json(res, 403, { error: 'outside workspace' });
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > 51200) return json(res, 422, { error: 'not a readable file' });
      return json(res, 200, { path: full, content: fs.readFileSync(full, 'utf8').slice(0, 51200) });
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/computer/files') {
    const gate = computerGate();
    if (gate) return gate;
    try {
      const body = await readJson(req);
      const full = jail(body.path ?? '');
      const content = String(body.content ?? '');
      if (!full) return json(res, 403, { error: 'outside workspace' });
      if (content.length > 100000) return json(res, 422, { error: 'content too large' });
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return json(res, 200, { saved: true, path: full });
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
  }
  const toolMatch = url.pathname.match(/^\/api\/tools\/([\w-]+)$/);
  if (toolMatch && req.method === 'POST') {
    return json(res, 501, {
      error: 'not-configured',
      tool: toolMatch[1],
      setup: 'This tool needs provider credentials on the gateway (e.g. music or smart-home accounts). Add them server-side first.',
    });
  }

  if (req.method === 'GET' && serveStatic(url, req, res)) return;
  return json(res, 404, { error: 'not-found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[gateway]', err);
    if (!res.headersSent) json(res, 500, { error: 'gateway-error' });
    else res.end();
  });
});

server.on('error', (err) => {
  if (err && typeof err === 'object' && 'code' in err && err.code === 'EADDRINUSE') {
    console.error(
      `[gateway] port ${PORT} is already in use — use the running server or set PORT to a free one.`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`[gateway] listening on http://localhost:${PORT} (model: ${UPSTREAM_MODEL} via ${UPSTREAM_BASE})`);
});
