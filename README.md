# Maya — Talk to someone who remembers.

A premium, voice-first AI companion. Press a button and talk: Maya listens,
thinks, and answers with voice while the UI streams text, waveform, and avatar
state in sync.

## Architecture

```text
Browser (React + TS + Tailwind + Web Audio)
 ├── Microphone → VAD → continuous STT (no restarts) → wake word ("hey maya")
 ├── Single brain: Google Gemini via backend gateway (images supported)
 ├── Tool loop: [SEARCH]/[WEATHER]/[REMINDER]/[EVENT] → execute → answer
 ├── Streaming text + system TTS or gateway cloud voice (MP3 chunks)
 ├── Realtime transport (WebSocketClient w/ reconnect + normalized RealtimeEvent)
 ├── Memory: local-first + sqlite-backed gateway sync, TF-IDF cosine retrieval
 ├── Knowledge docs (RAG): passages injected server-side into context
 ├── Emotion + relationship drift models → avatar / voice mapping
 └── Conversation state machine (disconnected … speaking … interrupted)
```

## What Maya can do

- **Talk or type** — auto conversation (VAD), push-to-talk, manual, full chat thread
- **Real answers with tools** — web search (Wikipedia/DDG), live weather (Open-Meteo),
  spoken reminders, local calendar events; sources shown under replies
- **See images** — attach photos in chat; the model grounds answers in them
- **Remember** — long-term memory (inspect/edit/forget) + knowledge documents
  with retrieval, per-user when accounts are enabled
- **Sound like herself** — system voice (female auto-pick) or cloud voice,
  emotion-mapped rate/pitch, interruption-safe playback
- **Express** — state-driven avatar (orb/halo/prism × violet/ocean/ember),
  real-amplitude waveform, typing indicator, streaming text
- **Privacy controls** — login gate on shared servers, export chats (Markdown/JSON),
  mic/storage/memory status, PWA installable

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
GET  /api/documents            POST /api/documents {title, text}
DELETE /api/documents/:id
POST /api/chat                 → { text }            (RAG notes injected)
POST /api/chat/stream          → SSE  data: {"delta": "…"} … data: [DONE]
POST /api/tools/web_search     {query} → { results: [{title, url, snippet}] }
POST /api/tools/weather        {location|lat,lon} → { place, temp, condition, … }
POST /api/tts                  {text} → { audios: [base64 mp3…] }
POST /api/login                {username, password} → { token, user } (USERS set)
GET  /api/health               → { ok, model, base, key, auth, db }
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
  after `silenceMs`. Recognition runs continuously (no restarts); interrupting
  Maya while she speaks stops TTS immediately.
- Push-to-talk: hold the orb (or Space when focused).
- Manual: tap to start/stop recording, then send.
- Wake word (beta, Settings): while the mic is on, "hey maya" switches her to listening.
- Voice (Settings): system voice with female auto-pick, or cloud voice (gateway MP3).
- Chrome/Edge have the best Web Speech STT; Safari/Firefox fall back to
  recorder + server STT via `audio.chunk`.

## Memory setup

Local-first in `localStorage` (`maya.memories.v1`); syncs to `/api/memories`
when reachable. Retrieval is TF-IDF cosine on-device. The gateway persists to
sqlite (`./data/maya.db`, FTS-indexed) with JSON fallback, scoped per user when
accounts are enabled. Knowledge documents (`Knowledge` panel) are chunked and
retrieved server-side into the model's context. Memory panel supports inspect /
edit / forget / disable / clear-all. Extraction deliberately stores one
non-sensitive fact per turn max.

Set `USERS="alice:pw1,bob:pw2"` on the gateway for multi-user login (home-grade
plaintext; production wants OAuth/DB). The app shows a sign-in gate automatically.

## Project layout

```text
src/app/            App shell, providers, view router
src/components/     avatar · waveform · voice · chat · settings · sidebar · memory · plans · common
src/features/       conversation state machine · personality/emotion engine · appearance accents
src/services/       ai · speech · audio · realtime · memory · tools · gateway client
src/hooks/          useConversation (engine) · useVoiceActivity · useRealtime · useMicrophone · useAudioAnalyzer
src/stores/         zustand: conversation · settings · maya · voice · auth
src/types/          strict domain types (no any)
src/utils/          formatting, capability checks, chat export
src/test/           vitest: machine, emotion, events, prompt, memory, tools, gateway
server/             zero-dep gateway: chat/stream, memory+docs store (sqlite/JSON),
                    tools (search/weather/tts), multi-user auth, static app serving
public/             PWA manifest + offline service worker + icon
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
- Set `GATEWAY_TOKEN` (+ baked `VITE_GATEWAY_TOKEN`) before exposing the gateway;
  set `USERS` for multi-user login. Validate ownership server-side (done for
  memories/documents via token-derived owners — never trust client claims).
- Authenticate WS (`session.start` + token), enforce CORS/origin checks
  (`ALLOWED_ORIGIN`), request size limits, rate limits.
- Privacy panel shows mic / storage / memory status and honors deletions.

## Production deployment

`npm run build` → serve `dist/` statically; terminate WS at your gateway;
set `VITE_API_URL` / `VITE_REALTIME_URL` at build time. Lazy-load nothing
special — the bundle is React + zustand only (~150 kB gz est.).
