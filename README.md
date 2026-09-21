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

## Quickstart

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
