/**
 * Maya reference backend — pluggable AI brain (Hugging Face / Google Gemini / local).
 *
 * Zero dependencies, Node 18+. Forwards Maya's backend contract onto any
 * OpenAI-compatible chat-completions endpoint, and keeps a tiny in-memory
 * memory store so the Memory panel works end-to-end.
 * (Swap the Map for a real DB before production.)
 *
 * Run (Hugging Face):
 *   HF_TOKEN=hf_xxx HF_MODEL=Qwen/Qwen2.5-7B-Instruct node server/hf-gateway.js
 *
 * Run (Google Gemini — free key from aistudio.google.com → Get API key):
 *   UPSTREAM_BASE=https://generativelanguage.googleapis.com/v1beta/openai \
 *   UPSTREAM_KEY=AIzaSy_xxx UPSTREAM_MODEL=gemini-3.6-flash node server/hf-gateway.js
 *   # or: set -a; source server/.env; set +a; node server/hf-gateway.js
 *
 * Run (local Ollama / vLLM — no key):
 *   UPSTREAM_BASE=http://localhost:11434/v1 UPSTREAM_MODEL=qwen2.5:3b node server/hf-gateway.js
 *
 * Then in Maya: Settings → AI Provider → pick the matching backend,
 * endpoint "/api" (Vite proxies it here in dev), model = your model ID.
 *
 * Env:
 *   UPSTREAM_BASE  brain endpoint (HF router, Gemini OpenAI-compat, or local)
 *   UPSTREAM_KEY   server-side key, sent as Bearer or x-goog-api-key (auto)
 *   UPSTREAM_MODEL default model when the client doesn't specify one
 *   HF_TOKEN / HF_MODEL / HF_BASE  legacy aliases for the HF setup above
 *   USERS      optional multi-user gate, e.g. USERS="alice:pw1,bob:pw2"
 *              (home-grade; empty = open single-user mode)
 *   DATA_DIR   storage dir for sqlite/JSON (default ./data)
 *   PORT       default 8787
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { store, STORE_KIND, parseUsers, verifyUser, issueToken } from './store.js';

const USERS = parseUsers();
const authEnabled = USERS.size > 0;

const PORT = Number(process.env.PORT ?? 8787);
// Optional shared secret: when set, every /api/* request must carry it as
// the x-gateway-token header, otherwise 401. Stops strangers from spending
// your upstream quota once the gateway is public. (No user accounts here —
// this is a shared-household/small-team gate, not bulletproof auth.)
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? '';
// Optional CORS lockdown: when set, only this origin is allowed.
// Default (empty) reflects the caller, which is fine for local dev.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '';
const UPSTREAM_BASE = (
  process.env.UPSTREAM_BASE ??
  process.env.HF_BASE ??
  'https://router.huggingface.co/v1'
).replace(/\/$/, '');
const UPSTREAM_MODEL =
  process.env.UPSTREAM_MODEL ?? process.env.HF_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct';
const UPSTREAM_KEY = process.env.UPSTREAM_KEY ?? process.env.HF_TOKEN ?? '';
// All OpenAI-compatible endpoints (HF router, Gemini /openai, Ollama, vLLM)
// authenticate with a Bearer token. Set UPSTREAM_AUTH=x-goog-api-key only
// when talking to Google's native (non-OpenAI) endpoints.
const UPSTREAM_AUTH = process.env.UPSTREAM_AUTH ?? 'bearer';
// Local upstreams need no key; huggingface.co and googleapis.com always do.
const needsAuth =
  UPSTREAM_BASE.includes('huggingface.co') || UPSTREAM_BASE.includes('googleapis.com');

function authHeaders() {
  if (!UPSTREAM_KEY) return {};
  if (UPSTREAM_AUTH === 'x-goog-api-key') return { 'x-goog-api-key': UPSTREAM_KEY };
  return { Authorization: `Bearer ${UPSTREAM_KEY}` };
}
const MAX_BODY = 1_000_000;

// Persistent store (sqlite when available, JSON files otherwise). Replaces
// the old in-memory Map — memories and documents survive restarts.
function bearerToken(req) {
  const h = req.headers.authorization ?? '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Owner id for scoping data. Open mode (no USERS) → shared 'local'. */
function ownerOf(req) {
  if (!authEnabled) return 'local';
  return store.userForToken(bearerToken(req)) ?? 'local';
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

async function callHf(messages, model, stream) {
  return fetch(`${UPSTREAM_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ model, messages, stream }),
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

/** Gateway voice: sentence-chunked MP3s (keyless provider), base64 JSON. */
async function toolTts(text) {
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

/** RAG: inject top saved-document chunks as a system note (owner-scoped). */
function injectNotes(owner, messages) {
  try {
    const q = lastUserText(messages);
    if (!q || q.length < 4) return messages;
    const hits = store.searchChunks(owner, q, 3);
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

async function handleChat(req, res) {
  if (needsAuth && !UPSTREAM_KEY) return json(res, 503, { error: 'gateway has no API key set (UPSTREAM_KEY)' });
  let body;
  try {
    body = await readJson(req);
  } catch {
    return json(res, 400, { error: 'invalid JSON body' });
  }
  const messages = injectNotes(ownerOf(req), toMessages(body));
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
  if (needsAuth && !UPSTREAM_KEY) {
    res.writeHead(503, headers);
    res.write(`data: ${JSON.stringify({ error: 'gateway has no API key set (UPSTREAM_KEY)' })}\n\n`);
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
  const messages = injectNotes(ownerOf(req), toMessages(body));
  if (!messages) {
    res.writeHead(400, headers);
    return res.end();
  }
  let hf;
  try {
    hf = await callHf(messages, pickModel(body), true);
  } catch {
    res.writeHead(502, headers);
    return res.end();
  }
  if (!hf.ok || !hf.body) {
    res.writeHead(502, headers);
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
    res.write('data: [DONE]\n\n');
    res.end();
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
    !store.userForToken(bearerToken(req))
  ) {
    return json(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, model: UPSTREAM_MODEL, base: UPSTREAM_BASE, key: UPSTREAM_KEY ? 'set' : needsAuth ? 'missing' : 'not-needed-locally', auth: authEnabled, db: STORE_KIND });
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    try {
      const body = await readJson(req);
      if (!authEnabled) return json(res, 200, { token: null, user: 'local' });
      const { username, password } = body;
      if (typeof username !== 'string' || !verifyUser(USERS, username, password)) {
        return json(res, 401, { error: 'invalid credentials' });
      }
      const token = issueToken();
      store.saveToken(token, username);
      return json(res, 200, { token, user: username });
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && url.pathname === '/api/chat/stream') return handleChatStream(req, res);

  if (req.method === 'GET' && url.pathname === '/api/memories') {
    return json(res, 200, store.listMemories(ownerOf(req)));
  }
  if (req.method === 'POST' && url.pathname === '/api/memories') {
    try {
      const m = await readJson(req);
      if (!m || typeof m.id !== 'string') return json(res, 400, { error: 'memory needs an id' });
      return json(res, 200, store.upsertMemory(ownerOf(req), m));
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
  }
  const memMatch = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
  if (memMatch) {
    const id = decodeURIComponent(memMatch[1]);
    const owner = ownerOf(req);
    if (req.method === 'DELETE') {
      store.deleteMemory(owner, id);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'PATCH') {
      try {
        const patch = await readJson(req);
        const updated = store.patchMemory(owner, id, patch);
        if (!updated) return json(res, 404, { error: 'not-found' });
        return json(res, 200, updated);
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/documents') {
    return json(res, 200, store.listDocs(ownerOf(req)));
  }
  if (req.method === 'POST' && url.pathname === '/api/documents') {
    try {
      const body = await readJson(req);
      const text = String(body.text ?? '').trim();
      if (!text) return json(res, 400, { error: 'empty document' });
      const title = String(body.title ?? '').trim().slice(0, 120) || text.slice(0, 40) || 'Untitled note';
      return json(res, 200, store.createDoc(ownerOf(req), title, text.slice(0, 20000)));
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
  }
  const docMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (docMatch && req.method === 'DELETE') {
    const ok = store.deleteDoc(ownerOf(req), decodeURIComponent(docMatch[1]));
    if (!ok) return json(res, 404, { error: 'not-found' });
    res.writeHead(204);
    return res.end();
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
    console.error('[hf-gateway]', err);
    if (!res.headersSent) json(res, 500, { error: 'gateway-error' });
    else res.end();
  });
});

server.on('error', (err) => {
  if (err && typeof err === 'object' && 'code' in err && err.code === 'EADDRINUSE') {
    console.error(
      `[hf-gateway] port ${PORT} is already in use — use the running server or set PORT to a free one.`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`[hf-gateway] listening on http://localhost:${PORT} (model: ${UPSTREAM_MODEL} via ${UPSTREAM_BASE})`);
});
