// Maya backend as a single Supabase Edge Function (`api`).
//
// Deploy: Supabase dashboard → Edge Functions → New function `api` → paste
// this file → Deploy. Then set secrets (Project Settings → Edge Functions):
//   UPSTREAM_BASE, UPSTREAM_KEY, UPSTREAM_MODEL, ALLOWED_ORIGIN (optional)
// Point the frontend at it: VITE_API_URL=https://<ref>.supabase.co/functions/v1
// (existing `/api/*` suffixes keep working — the router strips the prefix).
//
// What lives here vs local gateway:
//   KEEP: chat/stream, memories, docs+RAG, tools, tts, auth, health.
//   DROP: computer/* (local-machine only), scrypt/USERS login (Supabase Auth),
//         sqlite (Postgres directly), in-process rate limits (platform-level).

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_KEY') ?? '';
const UPSTREAM_BASE = (
  Deno.env.get('UPSTREAM_BASE') ??
  'https://generativelanguage.googleapis.com/v1beta/openai'
).replace(/\/$/, '');
const UPSTREAM_MODEL = Deno.env.get('UPSTREAM_MODEL') ?? 'gemini-3.6-flash';
const UPSTREAM_KEY = Deno.env.get('UPSTREAM_KEY') ?? '';
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '';
const MAX_BODY = 1_000_000;

const admin = createClient(
  SUPABASE_URL,
  // Supabase auto-provisions SUPABASE_SERVICE_ROLE_KEY (not ..._SERVICE_KEY).
  Deno.env.get('SUPABASE_SERVICE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  {
    auth: { persistSession: false },
  },
);

// ─── helpers ─────────────────────────────────────────────────────────────────

function cors(req: Request): Record<string, string> {
  const origin = ALLOWED_ORIGIN || req.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function json(body: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(req ? cors(req) : {}) },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

async function ownerOf(req: Request): Promise<string | null> {
  const h = req.headers.get('authorization') ?? '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const { data } = await admin.auth.getUser(m[1].trim());
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

function requireOwner(owner: string | null): owner is string {
  return owner !== null;
}

function toMessages(body: Record<string, unknown>): { role: string; content: unknown }[] | null {
  const raw = body.messages;
  if (Array.isArray(raw) && raw.length > 0) {
    const out: { role: string; content: unknown }[] = [];
    for (const m of (raw as Record<string, unknown>[]).slice(-20)) {
      if (!m || (typeof m.content !== 'string' && !Array.isArray(m.content))) continue;
      const role =
        m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
      if (typeof m.content === 'string') {
        const content = m.content.slice(0, 8000);
        if (content.trim()) out.push({ role, content });
        continue;
      }
      const parts = (m.content as unknown[])
        .filter((p) => p && typeof p === 'object')
        .slice(0, 5)
        .map((p) => {
          const part = p as { type?: unknown; text?: unknown; image_url?: unknown };
          if (part.type === 'text')
            return { type: 'text', text: String(part.text ?? '').slice(0, 8000) };
          if (part.type === 'image_url') {
            const iu = (part.image_url ?? {}) as { url?: unknown };
            const url = typeof iu.url === 'string' ? iu.url.slice(0, 500000) : '';
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
    return [{ role: 'user', content: (body.message as string).slice(0, 8000) }];
  }
  return null;
}

function pickModel(body: Record<string, unknown>): string {
  return typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : UPSTREAM_MODEL;
}

function lastUserText(messages: { role: string; content: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

function memRow(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    type: r.type,
    key: r.mkey,
    value: r.value,
    confidence: r.confidence,
    sourceConversationId: (r.source as string | null) ?? undefined,
    createdAt: r.created,
    updatedAt: r.updated,
    lastAccessedAt: r.accessed,
  };
}

function chunkText(text: string, max = 600): string[] {
  const paras = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  const push = (c: string) => {
    if (!c) return;
    if (c.length > max * 1.5) {
      for (let i = 0; i < c.length; i += max) out.push(c.slice(i, i + max).trim());
    } else out.push(c);
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

// ─── upstream brain ──────────────────────────────────────────────────────────

async function callUpstream(messages: unknown, model: string, stream: boolean): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    return await fetch(`${UPSTREAM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${UPSTREAM_KEY}` },
      body: JSON.stringify({ model, messages, stream }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function injectNotes(
  owner: string,
  messages: { role: string; content: unknown }[],
): Promise<{ role: string; content: unknown }[]> {
  try {
    const q = lastUserText(messages);
    if (!q || q.length < 4) return messages;
    const terms = Array.from(
      new Set((q.toLowerCase().match(/[a-z0-9\u0900-\u097f]{3,}/giu) ?? []).slice(0, 6)),
    );
    if (terms.length === 0) return messages;
    const orClause = terms.map((t) => `text.ilike.%${t}%`).join(',');
    const { data: hits } = await admin
      .from('chunks')
      .select('doc,idx,text')
      .eq('owner', owner)
      .or(orClause)
      .limit(3);
    if (!hits || hits.length === 0) return messages;
    const { data: docs } = await admin
      .from('docs')
      .select('id,title')
      .eq('owner', owner)
      .in('id', hits.map((h) => h.doc as string));
    const titles = new Map((docs ?? []).map((d) => [d.id as string, d.title as string]));
    const note =
      `Relevant notes from the user's saved documents (use them if helpful, never mention this block):\n` +
      hits
        .map(
          (h) =>
            `- [${titles.get(h.doc as string) ?? 'Note'}] ${String(h.text).slice(0, 500)}`,
        )
        .join('\n');
    const out = [...messages];
    const sysIdx = out.findIndex((m) => m && m.role === 'system');
    if (sysIdx >= 0) out.splice(sysIdx + 1, 0, { role: 'system', content: note });
    else out.unshift({ role: 'system', content: note });
    return out;
  } catch {
    return messages;
  }
}

// ─── keyless tools (same providers as the local gateway) ─────────────────────

const WX_CODE: Record<string, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow',
  75: 'heavy snow', 80: 'light showers', 81: 'showers', 82: 'violent showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};

async function toolWebSearch(query: unknown): Promise<unknown> {
  const q = String(query ?? '').slice(0, 200).trim();
  if (!q) return { results: [] };
  try {
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=5&origin=*`,
      { headers: { 'User-Agent': 'Maya/1.0 (personal assistant)' } },
    );
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        query?: { search?: { title: string; snippet?: string }[] };
      } | null;
      const results = (data?.query?.search ?? []).slice(0, 5).map((h) => ({
        title: h.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
        snippet: String(h.snippet ?? '').replace(/<[^>]+>/g, ''),
      }));
      if (results.length > 0) return { results };
    }
  } catch {
    /* fall through */
  }
  return { results: [] };
}

async function toolWeather(args: unknown): Promise<unknown> {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  let lat = Number(a.lat);
  let lon = Number(a.lon);
  let place = typeof a.location === 'string' ? a.location.slice(0, 80) : '';
  if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && place) {
    const g = (await (
      await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&format=json`,
      )
    ).json().catch(() => null)) as { results?: { latitude: number; longitude: number; name: string; country?: string }[] } | null;
    const first = g?.results?.[0];
    if (!first) return { error: 'place not found' };
    lat = first.latitude;
    lon = first.longitude;
    place = `${first.name}${first.country ? `, ${first.country}` : ''}`;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: 'need a location' };
  const w = (await (
    await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`,
    )
  ).json()) as {
    current?: { temperature_2m: number; relative_humidity_2m: number; weather_code: number; wind_speed_10m: number };
    daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
  } | null;
  if (!w?.current) return { error: 'weather unavailable' };
  return {
    place: place || `${lat.toFixed(2)},${lon.toFixed(2)}`,
    temp: w.current.temperature_2m,
    condition: WX_CODE[String(w.current.weather_code)] ?? 'unknown',
    high: w.daily?.temperature_2m_max?.[0],
    low: w.daily?.temperature_2m_min?.[0],
    humidity: w.current.relative_humidity_2m,
    wind: w.current.wind_speed_10m,
  };
}

async function toolTts(text: unknown): Promise<unknown> {
  const parts = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .flatMap((p) => (p.length > 180 ? [p.slice(0, 180)] : [p]))
    .slice(0, 8);
  if (parts.length === 0) return { audios: [] };
  const audios: string[] = [];
  for (const p of parts) {
    const res = await fetch(
      `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(p)}&tl=en&client=tw-ob`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } },
    );
    if (!res.ok) throw new Error(`tts ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 500) throw new Error('tts empty');
    let bin = '';
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    audios.push(btoa(bin));
  }
  return { audios };
}

// ─── router ──────────────────────────────────────────────────────────────────

function routePath(url: URL): string {
  for (const p of ['/functions/v1/api', '/api']) {
    if (url.pathname.startsWith(p)) return url.pathname.slice(p.length) || '/';
  }
  return url.pathname;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const path = routePath(url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  const H = cors(req);

  if (req.method === 'GET' && path === '/health') {
    return json(
      { ok: true, model: UPSTREAM_MODEL, base: UPSTREAM_BASE, key: UPSTREAM_KEY ? 'set' : 'missing', auth: true, db: 'supabase' },
      200, req,
    );
  }
  if (req.method === 'POST' && path === '/login') {
    return json({ error: 'use Supabase Auth (email sign-in) in the app' }, 410, req);
  }

  const owner = await ownerOf(req);
  if (!requireOwner(owner)) {
    return json({ error: 'unauthorized' }, 401, req);
  }
  const user = owner as string;

  // — chat —
  if (req.method === 'POST' && path === '/chat') {
    if (!UPSTREAM_KEY) return json({ error: 'gateway has no API key set' }, 503, req);
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return json({ error: 'invalid JSON body' }, 400, req);
    }
    const messages = await injectNotes(user, toMessages(body));
    if (!messages) return json({ error: 'expected { messages } or { message }' }, 400, req);
    const model = pickModel(body);
    let hf: Response;
    try {
      hf = await callUpstream(messages, model, false);
    } catch {
      return json({ error: 'hf-unreachable' }, 502, req);
    }
    if (!hf.ok) {
      const detail = await hf.text().catch(() => '');
      if (hf.status === 429) {
        const m = detail.match(/retry in ([\d.]+)s/i);
        return json({ error: 'rate-limited', retryAfter: m ? Math.max(1, Math.ceil(Number(m[1]))) : 60 }, 429, req);
      }
      return json({ error: 'hf-error', status: hf.status, detail: detail.slice(0, 500) }, 502, req);
    }
    const data = (await hf.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
    } | null;
    return json({ text: data?.choices?.[0]?.message?.content ?? '' }, 200, req);
  }

  // — chat stream (SSE relay) —
  if (req.method === 'POST' && path === '/chat/stream') {
    if (!UPSTREAM_KEY) {
      return new Response('data: [DONE]\n\n', {
        status: 503,
        headers: { ...H, 'Content-Type': 'text/event-stream; charset=utf-8' },
      });
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return new Response(null, { status: 400, headers: H });
    }
    const messages = await injectNotes(user, toMessages(body));
    if (!messages) return new Response(null, { status: 400, headers: H });
    const model = pickModel(body);
    let hf: Response;
    try {
      hf = await callUpstream(messages, model, true);
    } catch {
      return new Response('data: [DONE]\n\n', { status: 502, headers: H });
    }
    if (!hf.ok || !hf.body) {
      return new Response('data: [DONE]\n\n', {
        status: hf.status === 429 ? 429 : 502,
        headers: H,
      });
    }
    const stream = new ReadableStream({
      async start(controller) {
        const reader = hf.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const frames = buf.split('\n\n');
            buf = frames.pop() ?? '';
            for (const frame of frames) {
              const line = frame.trim();
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (payload === '[DONE]') {
                controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                controller.close();
                return;
              }
              try {
                const delta = (JSON.parse(payload) as {
                  choices?: { delta?: { content?: string } }[];
                }).choices?.[0]?.delta?.content;
                if (delta) {
                  controller.enqueue(
                    new TextEncoder().encode(`data: ${JSON.stringify({ delta })}\n\n`),
                  );
                }
              } catch {
                /* keep-alive */
              }
            }
          }
        } finally {
          try {
            reader.cancel();
          } catch {
            /* ignore */
          }
        }
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
      cancel() {
        /* client went away */
      },
    });
    return new Response(stream, {
      headers: { ...H, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }

  // — memories —
  if (req.method === 'GET' && path === '/memories') {
    const { data, error } = await admin.from('memories').select('*').eq('owner', user).order('updated', { ascending: false });
    if (error) return json({ error: 'db error' }, 502, req);
    return json((data ?? []).map(memRow), 200, req);
  }
  if (req.method === 'POST' && path === '/memories') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return json({ error: 'invalid JSON body' }, 400, req);
    }
    if (!body || typeof body.id !== 'string') return json({ error: 'memory needs an id' }, 400, req);
    const now = Date.now();
    const { data, error } = await admin
      .from('memories')
      .upsert({
        id: body.id,
        owner: user,
        type: body.type ?? 'fact',
        mkey: body.key ?? '',
        value: body.value ?? '',
        confidence: body.confidence ?? 0.7,
        source: (body.sourceConversationId as string | undefined) ?? null,
        created: (body.createdAt as number | undefined) ?? now,
        updated: now,
        accessed: now,
      })
      .select()
      .single();
    if (error) return json({ error: 'db error' }, 502, req);
    return json(memRow(data as Record<string, unknown>), 200, req);
  }
  const memMatch = path.match(/^\/memories\/([^/]+)$/);
  if (memMatch) {
    const id = decodeURIComponent(memMatch[1]);
    if (req.method === 'DELETE') {
      await admin.from('memories').delete().eq('id', id).eq('owner', user);
      return new Response(null, { status: 204, headers: H });
    }
    if (req.method === 'PATCH') {
      let patch: Record<string, unknown>;
      try {
        patch = await readJson(req);
      } catch {
        return json({ error: 'invalid JSON body' }, 400, req);
      }
      const { data, error } = await admin
        .from('memories')
        .update({
          ...(typeof patch.key === 'string' ? { mkey: patch.key } : {}),
          ...(typeof patch.value === 'string' ? { value: patch.value } : {}),
          updated: Date.now(),
          accessed: Date.now(),
        })
        .eq('id', id)
        .eq('owner', user)
        .select()
        .maybeSingle();
      if (error) return json({ error: 'db error' }, 502, req);
      if (!data) return json({ error: 'not-found' }, 404, req);
      return json(memRow(data as Record<string, unknown>), 200, req);
    }
  }
  if (req.method === 'GET' && path === '/memories/search') {
    const q = (url.searchParams.get('q') ?? '').slice(0, 200);
    const terms = Array.from(
      new Set((q.toLowerCase().match(/[a-z0-9\u0900-\u097f]{3,}/giu) ?? []).slice(0, 6)),
    );
    if (terms.length === 0) return json([], 200, req);
    const { data } = await admin
      .from('memories')
      .select('*')
      .eq('owner', user)
      .textSearch('value', terms.join(' | '))
      .limit(6);
    return json((data ?? []).map(memRow), 200, req);
  }

  // — documents —
  if (req.method === 'GET' && path === '/documents') {
    const { data: docs } = await admin
      .from('docs')
      .select('id,title,created')
      .eq('owner', user)
      .order('created', { ascending: false });
    const { data: counts } = await admin.from('chunks').select('doc').in('doc', (docs ?? []).map((d) => d.id as string));
    const nByDoc = new Map<string, number>();
    for (const c of counts ?? []) nByDoc.set(c.doc as string, (nByDoc.get(c.doc as string) ?? 0) + 1);
    return json(
      (docs ?? []).map((d) => ({ id: d.id, title: d.title, created: d.created, chunks: nByDoc.get(d.id as string) ?? 0 })),
      200, req,
    );
  }
  if (req.method === 'POST' && path === '/documents') {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return json({ error: 'invalid JSON body' }, 400, req);
    }
    const text = String(body.text ?? '').trim();
    if (!text) return json({ error: 'empty document' }, 400, req);
    const title = String(body.title ?? '').trim().slice(0, 120) || text.slice(0, 40) || 'Untitled note';
    const id = crypto.randomUUID();
    await admin.from('docs').insert({ id, owner: user, title, created: Date.now() });
    const chunks = chunkText(text.slice(0, 20000));
    if (chunks.length > 0) {
      await admin.from('chunks').insert(chunks.map((c, i) => ({ doc: id, idx: i, text: c, owner: user })));
    }
    return json({ id, title, chunks: chunks.length }, 200, req);
  }
  const docMatch = path.match(/^\/documents\/([^/]+)$/);
  if (docMatch && req.method === 'DELETE') {
    const { data } = await admin.from('docs').delete().eq('id', decodeURIComponent(docMatch[1])).eq('owner', user).select();
    if (!data || (data as unknown[]).length === 0) return json({ error: 'not-found' }, 404, req);
    await admin.from('chunks').delete().eq('doc', decodeURIComponent(docMatch[1]));
    return new Response(null, { status: 204, headers: H });
  }

  // — tools —
  if (req.method === 'POST' && path === '/tools/web_search') {
    try {
      const body = await readJson(req);
      return json(await toolWebSearch(body.query), 200, req);
    } catch {
      return json({ error: 'search unavailable' }, 502, req);
    }
  }
  if (req.method === 'POST' && path === '/tools/weather') {
    try {
      const body = await readJson(req);
      const out = (await toolWeather(body)) as Record<string, unknown>;
      if (out.error) return json(out, 422, req);
      return json(out, 200, req);
    } catch {
      return json({ error: 'weather unavailable' }, 502, req);
    }
  }
  if (req.method === 'POST' && path === '/tts') {
    try {
      const body = await readJson(req);
      return json(await toolTts(body.text), 200, req);
    } catch {
      return json({ error: 'tts unavailable' }, 502, req);
    }
  }
  const toolMatch = path.match(/^\/tools\/([\w-]+)$/);
  if (toolMatch && req.method === 'POST') {
    return json({ error: 'not-configured', tool: toolMatch[1] }, 501, req);
  }

  // computer endpoints are local-machine only
  if (path.startsWith('/computer/')) {
    return json({ error: 'computer-local-only' }, 501, req);
  }

  return json({ error: 'not-found' }, 404, req);
});

function pickModel(body: Record<string, unknown>): string {
  return typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : UPSTREAM_MODEL;
}
