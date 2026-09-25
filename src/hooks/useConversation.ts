import { useCallback, useEffect, useMemo, useRef } from 'react';
import { audioManager } from '../services/audio/AudioManager';
import { speechToText } from '../services/speech/SpeechToText';
import { textToSpeech, emotionToVoice } from '../services/speech/TextToSpeech';
import { OpenAICompatibleProvider } from '../services/ai/OpenAIProvider';
import type { AIProvider } from '../services/ai/AIProvider';
import { memoryService } from '../services/memory/MemoryService';
import { resolveChatBase, gatewayHeaders } from '../services/gateway';
import { useConversationStore } from '../stores/conversationStore';
import { useSettingsStore, sttLang } from '../stores/settingsStore';
import { useMayaStore } from '../stores/mayaStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { getTool, describeWhen, callGatewayTool } from '../services/tools/MayaTools';
import {
  parseComputerJobs, COMPUTER_TAG_RE, isBlocked, classifyRisk,
  computerExec, computerOpen, computerScreenshot, computerReadFile, computerWriteFile,
  recordAudit, type ComputerJob,
} from '../services/computer';
import { useComputerStore } from '../stores/computerStore';
import type { ChatMessage, ConversationContext, Memory, SourceRef, ToolCallRecord } from '../types';
import { nextSpeakable } from '../utils/speechChunks';

/**
 * Play gateway TTS sentence audio sequentially. Returns false so the caller
 * falls back to system TTS when the gateway has no voice configured.
 */
async function speakViaGateway(text: string, cancelled: () => boolean): Promise<boolean> {
  try {
    const data = (await callGatewayTool('tts', { text })) as { audios?: unknown };
    const chunks = (Array.isArray(data?.audios) ? data.audios : []).filter(
      (a): a is string => typeof a === 'string' && a.length > 0,
    );
    if (chunks.length === 0) return false;
    for (const b64 of chunks) {
      if (cancelled()) return true;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await audioManager.playAudioBuffer(bytes.buffer);
    }
    return true;
  } catch {
    return false;
  }
}

type ToolKind = 'search' | 'weather' | 'reminder' | 'event';

interface ToolJob {
  kind: ToolKind;
  name: string;
  arg1: string;
  arg2: string;
}

const TOOL_NAMES: Record<ToolKind, string> = {
  search: 'web_search',
  weather: 'weather',
  reminder: 'reminder',
  event: 'calendar',
};

/** Extract [SEARCH: ..] / [WEATHER: ..] / [REMINDER: .. | ..] / [EVENT: .. | ..] jobs. */
function extractToolJobs(text: string): ToolJob[] {
  const out: ToolJob[] = [];
  const re = /\[(SEARCH|WEATHER|REMINDER|EVENT):\s*([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < 6) {
    const kind = m[1].toLowerCase() as ToolKind;
    const parts = m[2].split('|').map((s) => s.trim());
    out.push({ kind, name: TOOL_NAMES[kind], arg1: parts[0] ?? '', arg2: parts[1] ?? '' });
  }
  return out;
}

const TOOL_TAG_RE = /\[(?:SEARCH|WEATHER|REMINDER|EVENT):\s*[^\]]+\]/g;

async function runToolJob(job: ToolJob): Promise<{
  text: string;
  summary: string;
  sources?: SourceRef[];
}> {
  const tool = getTool(job.name);
  if (!tool) throw new Error(`unknown tool ${job.name}`);
  if (job.kind === 'search') {
    const r = (await tool.execute({ query: job.arg1 })) as { results?: unknown };
    const items = (Array.isArray(r?.results) ? r.results : []).slice(0, 3).map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return {
        title: String(o.title ?? 'Result'),
        url: typeof o.url === 'string' && o.url ? o.url : undefined,
        snippet: String(o.snippet ?? ''),
      };
    });
    if (items.length === 0)
      return { text: 'no results found', summary: `searched "${job.arg1}" — nothing found` };
    return {
      text: items.map((i) => `${i.title}: ${i.snippet}`).join('\n'),
      summary: `searched "${job.arg1}"`,
      sources: items.map((i) => ({ title: i.title, url: i.url })),
    };
  }
  if (job.kind === 'weather') {
    const r = (await tool.execute({ location: job.arg1 })) as Record<string, unknown>;
    if (typeof r.error === 'string') throw new Error(r.error);
    const place = String(r.place ?? job.arg1);
    const text =
      `${place}: ${String(r.temp ?? '?')}°C, ${String(r.condition ?? 'unknown')}` +
      (r.high !== undefined ? ` (high ${String(r.high)}, low ${String(r.low)})` : '');
    return { text, summary: `weather for ${place}` };
  }
  if (job.kind === 'reminder') {
    const r = (await tool.execute({ text: job.arg1, when: job.arg2 })) as {
      at?: unknown;
      text?: unknown;
    };
    const at = typeof r.at === 'number' ? r.at : Date.now();
    return {
      text: `reminder "${String(r.text ?? job.arg1)}" set for ${describeWhen(at)}`,
      summary: 'reminder set',
    };
  }
  const r = (await tool.execute({ title: job.arg1, when: job.arg2 })) as {
    at?: unknown;
    title?: unknown;
  };
  const at = typeof r.at === 'number' ? r.at : Date.now();
  return {
    text: `event "${String(r.title ?? job.arg1)}" saved for ${describeWhen(at)}`,
    summary: 'event saved',
  };
}

/** Server-side semantic memories (embedding cosine), best-effort. */
async function fetchSemanticMemories(query: string): Promise<Memory[]> {
  try {
    const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';
    const res = await fetch(`${base}/api/memories/search?q=${encodeURIComponent(query.slice(0, 200))}`, {
      headers: gatewayHeaders(),
      credentials: 'include',
    });
    if (!res.ok) return [];
    const arr = (await res.json()) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: Memory[] = [];
    for (const x of arr) {
      const o = (x ?? {}) as Record<string, unknown>;
      if (typeof o.id !== 'string' || typeof o.key !== 'string' || typeof o.value !== 'string') continue;
      out.push({
        id: o.id,
        type: 'fact',
        key: o.key,
        value: o.value,
        confidence: typeof o.confidence === 'number' ? o.confidence : 0.7,
        sourceConversationId: typeof o.sourceConversationId === 'string' ? o.sourceConversationId : undefined,
        createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
        updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : Date.now(),
        lastAccessedAt: Date.now(),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function validMemoryType(t: unknown): Memory['type'] {
  return t === 'profile' || t === 'preference' || t === 'project' || t === 'interest' ||
    t === 'person' || t === 'event' || t === 'goal' || t === 'fact'
    ? t
    : 'fact';
}

async function approveComputer(
  title: string,
  job: ComputerJob,
  risk: 'read' | 'write' | 'system',
): Promise<boolean> {
  return useComputerStore.getState().requestApproval({
    tool: job.name,
    title,
    detail: job.detail,
    risk,
    warning:
      risk === 'system'
        ? 'This can type keys and drive apps. Watch what it does; deny anything surprising.'
        : undefined,
  });
}

async function runComputerJob(
  job: ComputerJob,
): Promise<{ text: string; summary: string; images?: string[] }> {
  const audit = (result: 'ok' | 'denied' | 'blocked' | 'failed', note?: string) =>
    recordAudit({ tool: job.name, detail: job.detail, result, note });
  const autoReads = useSettingsStore.getState().conversation.autoApproveReads !== false;
  switch (job.kind) {
    case 'screen': {
      try {
        const shot = await computerScreenshot();
        audit('ok', 'screenshot captured');
        return {
          text: 'screenshot captured (see attached image)',
          summary: 'screen captured',
          images: [shot],
        };
      } catch (err) {
        audit('failed', err instanceof Error ? err.message : undefined);
        throw err instanceof Error ? err : new Error('screenshot failed');
      }
    }
    case 'open': {
      if (!(await approveComputer(`Open "${job.arg}"?`, job, 'write'))) {
        audit('denied');
        throw new Error('user denied');
      }
      try {
        await computerOpen(job.arg);
        audit('ok');
        return { text: `opened ${job.arg}`, summary: `opened ${job.arg}` };
      } catch (err) {
        audit('failed');
        throw err instanceof Error ? err : new Error('open failed');
      }
    }
    case 'read': {
      try {
        const content = await computerReadFile(job.arg);
        audit('ok');
        return { text: `file ${job.arg}:\n${content.slice(0, 3000)}`, summary: `read ${job.arg}` };
      } catch (err) {
        audit('failed');
        throw err instanceof Error ? err : new Error('read failed');
      }
    }
    case 'write': {
      if (!(await approveComputer(`Write "${job.arg}"?`, job, 'write'))) {
        audit('denied');
        throw new Error('user denied');
      }
      try {
        await computerWriteFile(job.arg, job.content);
        audit('ok');
        return { text: `wrote ${job.arg}`, summary: `wrote ${job.arg}` };
      } catch (err) {
        audit('failed');
        throw err instanceof Error ? err : new Error('write failed');
      }
    }
    case 'run': {
      if (isBlocked(job.arg)) {
        audit('blocked', 'safety policy');
        throw new Error('refused by safety policy (destructive, privileged, or exfiltration pattern)');
      }
      const risk = classifyRisk(job.arg);
      if (!(risk === 'read' && autoReads)) {
        if (!(await approveComputer('Run this command?', job, risk))) {
          audit('denied');
          throw new Error('user denied');
        }
      }
      try {
        const r = await computerExec(job.arg);
        audit(r.code === 0 ? 'ok' : 'failed', `exit ${r.code}`);
        return {
          text: `exit ${r.code}${r.timedOut ? ' (timed out)' : ''}\nSTDOUT:\n${r.stdout.slice(0, 3000)}\nSTDERR:\n${r.stderr.slice(0, 1000)}`,
          summary: `ran ${job.arg.slice(0, 60)}`,
        };
      } catch (err) {
        audit('failed');
        throw err instanceof Error ? err : new Error('exec failed');
      }
    }
  }
}

/**
 * Conversation engine — the only place that orchestrates
 * mic → STT → provider → streaming text → TTS → avatar/memory.
 */
export function useConversationEngine() {
  const settings = useSettingsStore();
  const conv = useConversationStore();
  const maya = useMayaStore();
  const voice = useVoiceStore();

  const abortRef = useRef<AbortController | null>(null);
  const speakingRef = useRef(false);
  const processingRef = useRef(false);
  const spokenRef = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Single brain: Google Gemini via the backend gateway.
  // The model is sanitized here too, so no stale or mistyped value stored
  // in the browser can ever reach Google and fail the request.
  const provider: AIProvider = useMemo(() => {
    const raw = (settings.ai.model || '').trim();
    const model = /^gemini-[\w.]+$/i.test(raw) ? raw : 'gemini-3.6-flash';
    return new OpenAICompatibleProvider({
      endpoint: resolveChatBase(settings.ai.endpoint),
      model,
    });
  }, [settings.ai.endpoint, settings.ai.model]);

  const buildContext = useCallback(
    async (sessionId: string): Promise<ConversationContext> => {
      const st = useConversationStore.getState();
      const active = st.activeConversation();
      const recent = (active?.messages ?? []).slice(-12);
      const lastUser = [...recent].reverse().find((m) => m.role === 'user');
      const local = settingsRef.current.privacy.memoryEnabled
        ? memoryService.retrieve(lastUser?.text ?? '', 6)
        : [];
      // Blend local TF-IDF memories with server-side embedding matches.
      let relevantMemories = local;
      const query = lastUser?.text ?? '';
      if (settingsRef.current.privacy.memoryEnabled && query.trim().length > 2) {
        try {
          const remote = await fetchSemanticMemories(query);
          if (remote.length > 0) {
            const seen = new Set(local.map((m) => m.id));
            relevantMemories = [...local, ...remote.filter((m) => !seen.has(m.id))].slice(0, 6);
          }
        } catch {
          /* local memories suffice */
        }
      }
      return {
        sessionId,
        recentMessages: recent,
        relevantMemories,
        emotionalState: useMayaStore.getState().emotion,
        relationshipState: useMayaStore.getState().relationship,
        language: settingsRef.current.ai.language,
        userName: settingsRef.current.userName || undefined,
      };
    },
    [],
  );

  /** LLM memory extraction (heuristic runs first as instant fallback). */
  const extractMemoriesLLM = useCallback(
    async (userText: string, conversationId: string) => {
      if (userText.trim().length < 12) return;
      const ctx = await buildContext(conversationId);
      const now = Date.now();
      const res = await provider.generateResponse(
        [
          { id: crypto.randomUUID(), conversationId, role: 'user', text: userText.slice(0, 600), timestamp: now },
          {
            id: crypto.randomUUID(), conversationId, role: 'system', text:
              'Extract durable facts about the user as a JSON array ONLY, e.g. [{"type":"preference","key":"favorite_editor","value":"VS Code","confidence":0.9}]. ' +
              'Types: profile, preference, project, interest, person, event, goal, fact. Max 3 items. ' +
              'Reply [] if nothing durable. Never include passwords, tokens, or secrets.',
            timestamp: now,
          },
        ],
        ctx,
      );
      const fence = res.text.replace(/```json|```/g, '');
      const start = fence.indexOf('[');
      const end = fence.lastIndexOf(']');
      if (start < 0 || end <= start) return;
      const arr = JSON.parse(fence.slice(start, end + 1)) as unknown;
      if (!Array.isArray(arr)) return;
      for (const item of arr.slice(0, 3)) {
        const o = (item ?? {}) as Record<string, unknown>;
        const value = String(o.value ?? '').trim().slice(0, 300);
        const key = String(o.key ?? '').trim();
        if (!value || !key) continue;
        if (/password|secret|token|otp|ssn|credit/i.test(value)) continue;
        memoryService.upsert({
          type: validMemoryType(o.type),
          key,
          value,
          confidence:
            typeof o.confidence === 'number' ? Math.min(1, Math.max(0, o.confidence)) : 0.7,
          sourceConversationId: conversationId,
        });
      }
    },
    [buildContext, provider],
  );

  const speak = useCallback(async (text: string) => {
    const s = settingsRef.current;
    if (!s.conversation.autoPlayResponses || !s.voice.autoPlay) return;
    const emotion = useMayaStore.getState().emotion;
    const ve = emotionToVoice({
      excitement: emotion.excitement,
      mood: emotion.mood,
      energy: emotion.energy,
      concern: emotion.concern,
    });
    // Skip what streaming speech already voiced (sentence-by-sentence).
    const already = spokenRef.current;
    const body = already > 0 ? (already < text.length ? text.slice(already).trim() : '') : text;
    if (!body) {
      speakingRef.current = false;
      useMayaStore.getState().setTtsActive(false);
      if (settingsRef.current.conversation.autoListen) {
        useMayaStore.getState().setActivity('listening');
        useConversationStore.getState().setConvState('listening');
      } else {
        useMayaStore.getState().setActivity('idle');
        useConversationStore.getState().setConvState('connected');
      }
      return;
    }
    speakingRef.current = true;
    useMayaStore.getState().setActivity('speaking');
    useConversationStore.getState().setConvState('speaking');
    useMayaStore.getState().setTtsActive(true);
    const myAbort = abortRef.current;
    const cancelled = () =>
      abortRef.current !== myAbort || (myAbort?.signal.aborted ?? false);
    try {
      if ((s.voice.voiceId || '') === 'gateway') {
        // Cloud voice: sentence MP3s from the gateway, real output levels.
        // Falls back to system TTS when the gateway has no voice configured.
        const played = await speakViaGateway(body, cancelled);
        if (!played) {
          await textToSpeech.speak(body, {
            rate: s.voice.speed * ve.speed,
            pitch: s.voice.pitch * ve.pitch,
            emotion: ve,
          });
        }
      } else {
        await textToSpeech.speak(body, {
          rate: s.voice.speed * ve.speed,
          pitch: s.voice.pitch * ve.pitch,
          voiceId: s.voice.voiceId || undefined,
          emotion: ve,
        });
      }
    } finally {
      speakingRef.current = false;
      useMayaStore.getState().setTtsActive(false);
      // Back to listening if auto-listen, else connected idle.
      if (settingsRef.current.conversation.autoListen) {
        useMayaStore.getState().setActivity('listening');
        useConversationStore.getState().setConvState('listening');
      } else {
        useMayaStore.getState().setActivity('idle');
        useConversationStore.getState().setConvState('connected');
      }
    }
  }, []);

  const processTurn = useCallback(
    async (rawText: string, images: string[] = []) => {
      const text = rawText.trim();
      if ((!text && images.length === 0) || processingRef.current) return false;
      processingRef.current = true;
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      spokenRef.current = 0;

      // Everything below runs inside try/finally so the busy lock always
      // releases — a stuck lock silently swallows all future sends.
      let placeholder: ChatMessage | null = null;
      try {
      const st = useConversationStore.getState();
      let activeId = st.activeId;
      if (!activeId) activeId = st.newConversation();

      // User message (with attached images for multimodal models)
      const cleanImages = images
        .filter((u) => typeof u === 'string' && u.startsWith('data:image/'))
        .slice(0, 3);
      st.appendMessage({
        conversationId: activeId,
        role: 'user',
        text,
        ...(cleanImages.length > 0 ? { images: cleanImages } : {}),
      });
      st.setPartialUser('');
      st.setPartialMaya('');
      st.setConvState('processing');
      useMayaStore.getState().setActivity('processing');
      useMayaStore.getState().pushUserTurn(text);

      // Memory extraction: fast heuristic now, LLM pass in background.
      if (settingsRef.current.privacy.memoryEnabled) {
        memoryService.extractFromTurn(text, activeId);
        void extractMemoriesLLM(text, activeId).catch(() => undefined);
        // eslint-disable-next-line no-misleading-character-class -- Devanagari block intentionally includes combining marks
        const nameHit = text.match(/(?:my name is|call me)\s+([A-Za-z\u0900-\u097F][\w\u0900-\u097F .-]{1,30})/iu);
        if (nameHit && !settingsRef.current.userName) {
          useSettingsStore.getState().update('userName', nameHit[1].trim());
        }
      }

      // Assistant placeholder for streaming
      placeholder = st.appendMessage({
        conversationId: activeId,
        role: 'assistant',
        text: '',
        partial: true,
      });

        const ctx = await buildContext(activeId);
        if (cleanImages.length > 0) ctx.images = cleanImages;
        const stream = provider.sendMessage(text, ctx);

        let full = '';
        for await (const ch of stream) {
          if (abort.signal.aborted) break;
          if (ch.text) {
            full += ch.text;
            useConversationStore.getState().updateMessage(placeholder.id, { text: full, partial: true });
            useConversationStore.getState().setPartialMaya(full);
            // Streaming speech: voice finished sentences while the rest
            // streams in (system voice path; gateway voice plays whole).
            const sNow = settingsRef.current;
            if (
              sNow.conversation.streamSpeech !== false &&
              (sNow.voice.voiceId || '') !== 'gateway' &&
              !abort.signal.aborted
            ) {
              const next = nextSpeakable(full, spokenRef.current);
              if (next) {
                spokenRef.current = next.newLen;
                speakingRef.current = true;
                useMayaStore.getState().setActivity('speaking');
                useConversationStore.getState().setConvState('speaking');
                useMayaStore.getState().setTtsActive(true);
                const em = useMayaStore.getState().emotion;
                const vv = emotionToVoice({
                  excitement: em.excitement, mood: em.mood, energy: em.energy, concern: em.concern,
                });
                void textToSpeech
                  .speak(next.text, {
                    rate: sNow.voice.speed * vv.speed,
                    pitch: sNow.voice.pitch * vv.pitch,
                    voiceId: sNow.voice.voiceId || undefined,
                    emotion: vv,
                  })
                  .catch(() => undefined);
              }
            }
          }
          if (ch.mayaState) useMayaStore.getState().setAvatarOverride(ch.mayaState);
          if (ch.done) break;
        }
        // Tool rounds: the model may request searches, weather, reminders or
        // events via [TAG: ...] markers. Execute (max 2 rounds), strip the
        // markers from what the user sees, then answer with the results.
        let finalText = full.trim() || 'Hmm — I lost that thought. Say it once more?';
        const allSources: SourceRef[] = [];
        const toolCalls: ToolCallRecord[] = [];
        for (let round = 0; round < 2 && !abort.signal.aborted; round++) {
          const jobs = extractToolJobs(finalText);
          if (jobs.length === 0) break;
          finalText = finalText.replace(TOOL_TAG_RE, '').trim();
          const resultLines: string[] = [];
          for (const job of jobs.slice(0, 3)) {
            try {
              const r = await runToolJob(job);
              resultLines.push(`${r.summary} → ${r.text}`);
              if (r.sources) allSources.push(...r.sources);
              toolCalls.push({ name: job.name, summary: r.summary });
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'failed';
              resultLines.push(`${job.name} unavailable (${msg})`);
              toolCalls.push({ name: job.name, summary: 'failed' });
            }
          }
          const followCtx = await buildContext(activeId);
          const now = Date.now();
          const followMsgs: ChatMessage[] = [
            ...followCtx.recentMessages.slice(-8),
            { id: crypto.randomUUID(), conversationId: activeId, role: 'user', text, timestamp: now },
            {
              id: crypto.randomUUID(), conversationId: activeId, role: 'assistant',
              text: finalText || '(thinking)', timestamp: now,
            },
            {
              id: crypto.randomUUID(), conversationId: activeId, role: 'user',
              text: `Tool results — answer the user now, briefly, in their language, with no [TAG: ...] markers:\n${resultLines.join('\n')}`,
              timestamp: now,
            },
          ];
          const follow = await provider.generateResponse(followMsgs, followCtx);
          if (follow.text.trim()) finalText = follow.text.trim();
        }
        // Computer rounds: screen/action/file markers with approval gates.
        // Same shape as tool rounds, plus vision follow-ups for screenshots.
        for (let round = 0; round < 2 && !abort.signal.aborted; round++) {
          const cjobs = parseComputerJobs(finalText);
          if (cjobs.length === 0) break;
          finalText = finalText.replace(COMPUTER_TAG_RE, '').trim();
          const resultLines: string[] = [];
          const followImages: string[] = [];
          for (const job of cjobs.slice(0, 2)) {
            try {
              const r = await runComputerJob(job);
              resultLines.push(`${job.name} → ${r.text}`);
              if (r.images) followImages.push(...r.images);
              toolCalls.push({ name: job.name, summary: r.summary });
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'failed';
              resultLines.push(`${job.name} unavailable (${msg})`);
              toolCalls.push({ name: job.name, summary: 'failed' });
            }
          }
          const followCtx2 = await buildContext(activeId);
          const now2 = Date.now();
          const follow2 = await provider.generateResponse(
            [
              ...followCtx2.recentMessages.slice(-8),
              { id: crypto.randomUUID(), conversationId: activeId, role: 'user', text, timestamp: now2 },
              {
                id: crypto.randomUUID(), conversationId: activeId, role: 'assistant',
                text: finalText || '(thinking)', timestamp: now2,
              },
              {
                id: crypto.randomUUID(), conversationId: activeId, role: 'user',
                text: `Computer results — continue helping, briefly, with no [TAG: ...] markers:\n${resultLines.join('\n')}`,
                ...(followImages.length > 0 ? { images: followImages } : {}),
                timestamp: now2,
              },
            ],
            followCtx2,
          );
          if (follow2.text.trim()) finalText = follow2.text.trim();
        }
        useConversationStore.getState().updateMessage(placeholder.id, {
          text: finalText,
          partial: false,
          ...(allSources.length > 0 ? { sources: allSources } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
        useConversationStore.getState().setPartialMaya('');
        useMayaStore.getState().setAvatarOverride(null);
        useMayaStore.getState().pushMayaTurn(finalText);
        await speak(finalText);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Request failed';
        if (/401|unauthorized/i.test(message)) useAuthStore.getState().logout();
        if (placeholder) {
          useConversationStore.getState().updateMessage(placeholder.id, {
            text: 'I lost the connection for a moment. Try again?',
            partial: false,
          });
        }
        useConversationStore.getState().setError({
          code: /credential|key/i.test(message) ? 'invalid-key' : 'ai-timeout',
          message,
          recoverable: true,
        });
        useMayaStore.getState().setActivity('idle');
        useConversationStore.getState().setConvState('connected');
        return true;
      } finally {
        processingRef.current = false;
      }
    },
    [buildContext, extractMemoriesLLM, provider, speak],
  );

  const interrupt = useCallback(() => {
    abortRef.current?.abort();
    textToSpeech.stop();
    audioManager.interrupt();
    speakingRef.current = false;
    processingRef.current = false;
    useMayaStore.getState().setTtsActive(false);
    useMayaStore.getState().setAvatarOverride(null);
    useMayaStore.getState().setActivity('listening');
    const st = useConversationStore.getState();
    // Legal path: speaking -> interrupted -> listening
    st.setConvState('interrupted');
    st.setConvState('listening');
  }, []);

  const ensureMic = useCallback(async (): Promise<boolean> => {
    if (!audioManager.available) {
      useConversationStore.getState().setError({
        code: 'unsupported-browser',
        message: 'This browser does not support microphone audio.',
        recoverable: false,
      });
      return false;
    }
    try {
      audioManager.initialize();
      await audioManager.requestMicrophone(
        settingsRef.current.audio.inputDeviceId || undefined,
      );
      useVoiceStore.getState().setMicPermission('granted');
      useVoiceStore.getState().setMicActive(true);
      return true;
    } catch (err) {
      const name = (err as DOMException)?.name;
      useVoiceStore.getState().setMicPermission(name === 'NotAllowedError' ? 'denied' : 'prompt');
      useConversationStore.getState().setError({
        code: 'mic-denied',
        message:
          name === 'NotAllowedError'
            ? 'Microphone access was denied. Allow it in your browser to talk to Maya.'
            : 'Could not access the microphone.',
        recoverable: true,
      });
      return false;
    }
  }, []);

  const startListening = useCallback(async () => {
    const ok = await ensureMic();
    if (!ok) return;
    const st = useConversationStore.getState();
    if (!st.activeId) st.newConversation();
    st.setConvState('listening');
    useMayaStore.getState().setActivity('listening');
    speechToText.start(
      {
        onPartial: (t) => {
          useConversationStore.getState().setPartialUser(t);
          // Beta wake word: while the mic is on but Maya is idle, hearing
          // "hey maya" switches her to listening (uses live transcription).
          const s = settingsRef.current;
          if (
            s.conversation.wakeWord &&
            !speakingRef.current &&
            !processingRef.current &&
            /\b(hey maya|ok maya|okay maya)\b/i.test(t)
          ) {
            speechToText.consumeFinals();
            useConversationStore.getState().setPartialUser('');
            useConversationStore.getState().setConvState('listening');
            useMayaStore.getState().setActivity('listening');
          }
        },
        onFinal: (t) => useConversationStore.getState().setPartialUser(t),
        onError: (m) => {
          if (m !== 'no-speech' && m !== 'aborted')
            useVoiceStore.getState().setLastError({ code: 'stt-failure', message: m, recoverable: true });
        },
      },
      sttLang(settingsRef.current.ai.language),
    );
  }, [ensureMic]);

  const stopListeningAndSend = useCallback(() => {
    const finalText =
      speechToText.stop() ||
      useConversationStore.getState().partialUser.trim();
    useConversationStore.getState().setPartialUser('');
    if (finalText.trim()) void processTurn(finalText);
    else {
      useMayaStore.getState().setActivity('idle');
      useConversationStore.getState().setConvState('connected');
    }
  }, [processTurn]);

  /** VAD speech-start → barge-in. Called by the VAD hook. */
  const handleVadStart = useCallback(() => {
    const s = settingsRef.current;
    if (speakingRef.current && s.conversation.allowInterrupt) {
      interrupt();
      // Restart STT capture so the interruption itself is transcribed.
      if (!speechToText.isListening) {
        speechToText.start(
          {
            onPartial: (t) => useConversationStore.getState().setPartialUser(t),
            onFinal: (t) => useConversationStore.getState().setPartialUser(t),
          },
          sttLang(s.ai.language),
        );
      }
    }
  }, [interrupt]);

  const handleVadEnd = useCallback(() => {
    const s = settingsRef.current;
    if (s.voiceMode !== 'auto' || !s.audio.vadEnabled) return;
    if (speakingRef.current || processingRef.current) return;
    // Continuous mode: the recognizer keeps running across turns (no
    // stop/start churn) — consume what finalized since the last send.
    const t =
      speechToText.consumeFinals() ||
      useConversationStore.getState().partialUser.trim();
    if (t.trim().length > 1) {
      useConversationStore.getState().setPartialUser('');
      void processTurn(t);
    }
  }, [processTurn]);

  // Boot: connecting → connected.
  useEffect(() => {
    const st = useConversationStore.getState();
    st.setConvState('connecting');
    const t = setTimeout(() => {
      st.setConvState('connected');
      if (settingsRef.current.conversation.autoListen) {
        // Do not auto-request mic (autoplay/policy) — wait for user gesture.
        useMayaStore.getState().setActivity('idle');
      }
    }, 500);
    void memoryService.syncPull();
    return () => clearTimeout(t);
  }, []);

  // Keyboard shortcuts: Space push-to-talk, Esc stop, Cmd+K search, Cmd+N new.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        useConversationStore.getState().newConversation();
      }
      if (e.key === 'Escape' && speakingRef.current) {
        e.preventDefault();
        interrupt();
      }
      if (e.code === 'Space' && !typing && !e.repeat) {
        // Space handled by VoiceButton focus; global fallback:
        void 0;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interrupt]);

  return useMemo(
    () => ({
      provider,
      processTurn,
      interrupt,
      ensureMic,
      startListening,
      stopListeningAndSend,
      handleVadStart,
      handleVadEnd,
      isSpeaking: () => speakingRef.current,
      isProcessing: () => processingRef.current,
      state: {
        conv: conv.convState,
        connection: conv.connection,
        avatar: maya.avatarState,
        mic: voice.micPermission,
      },
    }),
    [
      provider,
      processTurn,
      interrupt,
      ensureMic,
      startListening,
      stopListeningAndSend,
      handleVadStart,
      handleVadEnd,
      conv.convState,
      conv.connection,
      maya.avatarState,
      voice.micPermission,
    ],
  );
}

export type ConversationEngine = ReturnType<typeof useConversationEngine>;
