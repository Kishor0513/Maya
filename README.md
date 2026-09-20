# Maya — Talk to someone who remembers.

A premium, voice-first AI companion. Press a button and talk: Maya listens,
thinks, and answers with voice while the UI streams text, waveform, and avatar
state in sync.

## Architecture

```text
Browser (React + TS + Tailwind + Web Audio)
 ├── Microphone → VAD → STT (Web Speech live partials)
 ├── AI provider abstraction (demo / backend-proxied OpenAI-compatible / custom)
 ├── Streaming text + system TTS (pluggable provider audio.chunk path)
 ├── Realtime transport (WebSocketClient w/ reconnect + normalized RealtimeEvent)
 ├── Memory (local-first + backend sync surface, lexical retrieval)
 ├── Emotion + relationship drift models → avatar / voice mapping
 └── Conversation state machine (disconnected … speaking … interrupted)
```

No vendor secrets in the frontend. The browser talks to **your backend
gateway** (`/api/*`, `WS /api/realtime`), which holds provider keys, runs the
real STT/LLM/memory-extraction/vector retrieval, and enforces auth, rate
limits, and ownership checks.

## Quickstart (demo mode — no backend needed)

```bash
npm install
npm run dev
```

Maya runs on Google Gemini through the included zero-dependency gateway,
which also serves the app itself — one stable server, no build tools,
no proxy, and no CORS at runtime:

```bash
npm install
npm run build        # once (rebuild after frontend changes)
set -a; source server/.env; set +a
node server/hf-gateway.js   # → open http://localhost:8787
```

Just talk — Talk and Chat views, voice, memory, streaming, and interruption
all run against the live model. (For development with hot reload instead:
run the gateway, then `npm run dev` and open the URL it prints.)

Two views share one conversation: **Talk** (voice stage with avatar +
waveform) and **Chat** (full message thread with streaming bubbles, typing
indicator, and suggestion chips). Voice keeps working in Chat — interrupt and
auto-listen apply in both.

## Backend setup (Google Gemini — the only brain)

1. Get a free key at **aistudio.google.com → Get API key**.
2. `cp server/.env.example server/.env`, then set:
   ```bash
   UPSTREAM_BASE=https://generativelanguage.googleapis.com/v1beta/openai
   UPSTREAM_KEY=AIzaSy_paste_yours_here
   UPSTREAM_MODEL=gemini-3.6-flash
   ```
3. `set -a; source server/.env; set +a; node server/hf-gateway.js` → health at `curl localhost:8787/api/health`.
4. `npm run dev` → http://localhost:5173. The app is Gemini-only: Settings shows the fixed provider, endpoint `/api` (proxied to the gateway in dev).

## Hosting

**Cheapest true answer: Render, all free.** This repo ships a `render.yaml`
blueprint: one free static site (frontend, never sleeps) + one free Docker
web service (gateway, sleeps when idle — first message after sleep takes
~30–60s to wake, then instant). Dashboard → New → Blueprint → this repo,
paste the two prompted secrets, done. Your Gemini API free quota is separate
and unaffected.

One process serves everything (app + API + memory). You need:
- Brain config (`UPSTREAM_*`) + `PORT` — see `server/.env.example`
- `GATEWAY_TOKEN` — set a random string when public, plus matching
  `VITE_GATEWAY_TOKEN` baked into the frontend build (`VITE_GATEWAY_TOKEN=… npm run build`)
- `ALLOWED_ORIGIN=https://your-domain` to lock CORS down in production

### Option 1: Railway / Render / Fly.io (easiest, HTTPS included)

- New service from this repo. Build command: `npm ci && npm run build`. Start: `npm run start`.
- Set the env vars in the dashboard. You get `https://…` automatically —
  **HTTPS is required for the microphone** (browsers block mic on plain HTTP).
- Free tiers comfortably run this (the gateway is tiny; the AI runs at Google).

### Option 2: Any VPS with Docker

```bash
docker build -t maya .
docker run -d --restart unless-stopped -p 8787:8787 --env-file server/.env maya
```

Put Caddy/Nginx in front for automatic HTTPS, e.g. Caddy `reverse_proxy localhost:8787` on your domain. (`.dockerignore` keeps `server/.env` secrets out of the image — pass them with `--env-file` instead.)

### Option 1.5: Frontend on Vercel / Netlify + gateway elsewhere (split)

The static frontend **can** live on Vercel/Netlify; the Node gateway **cannot** —
it needs always-on hosting (Option 1 or 2 above) for the API key, SSE streaming,
and memory. Serverless functions are not a drop-in home for it (10–60s limits
vs. long streams, plus memory would need an external DB).

- Deploy the gateway first → note its URL, e.g. `https://maya-gw.onrender.com`
- Vercel/Netlify: import the repo. Build `npm ci && npm run build`, output dir `dist`.
- Environment — set **before building**, Vite bakes these in:
  `VITE_API_URL=https://maya-gw.onrender.com`, `VITE_GATEWAY_TOKEN=<same as gateway>`.
  The app then calls the gateway directly; no Settings change needed.
- On the gateway set `ALLOWED_ORIGIN=https://your-app.vercel.app`.
- HTTPS on both ends (Vercel gives it to the frontend, Render/Railway to the
  gateway) — the mic needs it, and so do the cross-origin API calls.
- Rebuild + redeploy the frontend whenever these vars change. Voice realtime
  stays local-loopback (the gateway has no WS endpoint); chat, voice I/O,
  streaming, and memory all work.

### Production warnings

- **Mic needs HTTPS.** An `http://your-ip` URL will load, but voice input won't work.
- **Set GATEWAY_TOKEN.** Without it, anyone with the URL spends your Gemini quota. It's a shared secret, not user accounts — right for personal/small-team use.
- **Memory is in-process RAM.** Gateway restarts wipe server-side `/api/memories` (browsers keep their own copy). Plug in SQLite/Postgres before real use.
- **No user accounts.** Don't host one instance for strangers.

### Backend contract

```text
POST /api/conversations        GET /api/conversations
GET  /api/conversations/:id    DELETE /api/conversations/:id
GET  /api/memories             POST /api/memories
PATCH /api/memories/:id        DELETE /api/memories/:id
POST /api/chat                 → { text }
POST /api/chat/stream          → SSE  data: {"delta": "…"} … data: [DONE]
WS   /api/realtime             ↔ normalized frames (see below)
```

Realtime frames (client → server): `session.start`, `audio.chunk` (base64),
`message.text`, `interrupt`, `ping`. Server → client: `transcript.partial`,
`transcript.final`, `response.text` / `response.done`, `audio.chunk` (base64),
`maya.state`, `sources`, `tool.activity`, `error`. The frontend normalizes all
of this in `src/services/realtime/events.ts` — keep provider quirks in
adapters, never in components.

Server-side system prompt lives conceptually in
`src/services/ai/prompt.ts#buildSystemPrompt` — compose it on the backend with
recent messages + summary + retrieved memories + emotion/relationship state.

## Voice setup

- Auto conversation (default): mic on → VAD detects speech start/end → sends
  after `silenceMs`. Interrupting Maya while she speaks stops TTS immediately.
- Push-to-talk: hold the orb (or Space when focused).
- Manual: tap to start/stop recording, then send.
- Chrome/Edge have the best Web Speech STT; Safari/Firefox fall back to
  recorder + server STT via `audio.chunk`.

## Memory setup

Local-first in `localStorage` (`maya.memories.v1`); syncs to `/api/memories`
when reachable. Retrieval is lexical on-device (stand-in for vector search —
swap the backend to embeddings + vector DB without touching the UI).
Memory panel supports inspect / edit / forget / disable / clear-all.
Extraction deliberately stores one non-sensitive fact per turn max.

## Project layout

```text
src/app/            App shell, providers, view router
src/components/     avatar · waveform · voice · chat · settings · sidebar · memory · common
src/features/       conversation state machine · personality/emotion engine
src/services/       ai · speech · audio · realtime · memory · tools
src/hooks/          useConversation (engine) · useVoiceActivity · useRealtime · useMicrophone · useAudioAnalyzer
src/stores/         zustand: conversation · settings · maya · voice
src/types/          strict domain types (no any)
src/utils/          formatting, capability checks
src/test/           vitest: machine, emotion, events, prompt, memory
```

## Scripts

```bash
npm run dev       # local dev
npm run build     # typecheck + production build
npm run preview   # serve dist
npm run lint      # eslint (no any, strict hooks)
npm run test      # vitest run
```

## Security notes

- Never put provider keys in `VITE_*` vars — they ship to the browser.
- Authenticate WS (`session.start` + token), validate `userId`/ownership
  server-side, enforce CORS/origin checks, request size limits, rate limits.
- Privacy panel shows mic / storage / memory status and honors deletions.

## Production deployment

`npm run build` → serve `dist/` statically; terminate WS at your gateway;
set `VITE_API_URL` / `VITE_REALTIME_URL` at build time. Lazy-load nothing
special — the bundle is React + zustand only (~150 kB gz est.).
