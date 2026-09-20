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
 *   PORT       default 8787
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

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

// Demo-grade store: id -> memory object. Use Postgres/SQLite in production.
const memories = new Map();

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
      if (!m || typeof m.content !== 'string') continue;
      const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
      const content = m.content.slice(0, 8000);
      if (content.trim()) out.push({ role, content });
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

async function handleChat(req, res) {
  if (needsAuth && !UPSTREAM_KEY) return json(res, 503, { error: 'gateway has no API key set (UPSTREAM_KEY)' });
  let body;
  try {
    body = await readJson(req);
  } catch {
    return json(res, 400, { error: 'invalid JSON body' });
  }
  const messages = toMessages(body);
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
  const messages = toMessages(body);
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

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, model: UPSTREAM_MODEL, base: UPSTREAM_BASE, key: UPSTREAM_KEY ? 'set' : needsAuth ? 'missing' : 'not-needed-locally' });
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && url.pathname === '/api/chat/stream') return handleChatStream(req, res);

  if (req.method === 'GET' && url.pathname === '/api/memories') {
    return json(res, 200, [...memories.values()]);
  }
  if (req.method === 'POST' && url.pathname === '/api/memories') {
    try {
      const m = await readJson(req);
      if (!m || typeof m.id !== 'string') return json(res, 400, { error: 'memory needs an id' });
      memories.set(m.id, m);
      return json(res, 200, m);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
  }
  const memMatch = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
  if (memMatch) {
    const id = decodeURIComponent(memMatch[1]);
    if (req.method === 'DELETE') {
      memories.delete(id);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'PATCH') {
      const existing = memories.get(id);
      if (!existing) return json(res, 404, { error: 'not-found' });
      try {
        const patch = await readJson(req);
        const merged = { ...existing, ...patch, id };
        memories.set(id, merged);
        return json(res, 200, merged);
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
    }
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
