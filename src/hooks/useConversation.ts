import { useCallback, useEffect, useMemo, useRef } from 'react';
import { audioManager } from '../services/audio/AudioManager';
import { speechToText } from '../services/speech/SpeechToText';
import { textToSpeech, emotionToVoice } from '../services/speech/TextToSpeech';
import { OpenAICompatibleProvider } from '../services/ai/OpenAIProvider';
import type { AIProvider } from '../services/ai/AIProvider';
import { memoryService } from '../services/memory/MemoryService';
import { resolveChatBase } from '../services/gateway';
import { useConversationStore } from '../stores/conversationStore';
import { useSettingsStore, sttLang } from '../stores/settingsStore';
import { useMayaStore } from '../stores/mayaStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { getTool, describeWhen, callGatewayTool } from '../services/tools/MayaTools';
import type { ChatMessage, ConversationContext, SourceRef, ToolCallRecord } from '../types';

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
    (sessionId: string): ConversationContext => {
      const st = useConversationStore.getState();
      const active = st.activeConversation();
      const recent = (active?.messages ?? []).slice(-12);
      const lastUser = [...recent].reverse().find((m) => m.role === 'user');
      return {
        sessionId,
        recentMessages: recent,
        relevantMemories: settingsRef.current.privacy.memoryEnabled
          ? memoryService.retrieve(lastUser?.text ?? '', 6)
          : [],
        emotionalState: useMayaStore.getState().emotion,
        relationshipState: useMayaStore.getState().relationship,
        language: settingsRef.current.ai.language,
        userName: settingsRef.current.userName || undefined,
      };
    },
    [],
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
        const played = await speakViaGateway(text, cancelled);
        if (!played) {
          await textToSpeech.speak(text, {
            rate: s.voice.speed * ve.speed,
            pitch: s.voice.pitch * ve.pitch,
            emotion: ve,
          });
        }
      } else {
        await textToSpeech.speak(text, {
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
      if ((!text && images.length === 0) || processingRef.current) return;
      processingRef.current = true;
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

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

      // Memory extraction (local heuristic; backend runs the real one)
      if (settingsRef.current.privacy.memoryEnabled) {
        memoryService.extractFromTurn(text, activeId);
        // eslint-disable-next-line no-misleading-character-class -- Devanagari block intentionally includes combining marks
        const nameHit = text.match(/(?:my name is|call me)\s+([A-Za-z\u0900-\u097F][\w\u0900-\u097F .-]{1,30})/iu);
        if (nameHit && !settingsRef.current.userName) {
          useSettingsStore.getState().update('userName', nameHit[1].trim());
        }
      }

      // Assistant placeholder for streaming
      const placeholder = st.appendMessage({
        conversationId: activeId,
        role: 'assistant',
        text: '',
        partial: true,
      });

      try {
        const ctx = buildContext(activeId);
        if (cleanImages.length > 0) ctx.images = cleanImages;
        const stream = provider.sendMessage(text, ctx);

        let full = '';
        for await (const ch of stream) {
          if (abort.signal.aborted) break;
          if (ch.text) {
            full += ch.text;
            useConversationStore.getState().updateMessage(placeholder.id, { text: full, partial: true });
            useConversationStore.getState().setPartialMaya(full);
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
          const followCtx = buildContext(activeId);
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
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Request failed';
        if (/401|unauthorized/i.test(message)) useAuthStore.getState().logout();
        useConversationStore.getState().updateMessage(placeholder.id, {
          text: 'I lost the connection for a moment. Try again?',
          partial: false,
        });
        useConversationStore.getState().setError({
          code: /credential|key/i.test(message) ? 'invalid-key' : 'ai-timeout',
          message,
          recoverable: true,
        });
        useMayaStore.getState().setActivity('idle');
        useConversationStore.getState().setConvState('connected');
      } finally {
        processingRef.current = false;
      }
    },
    [buildContext, provider, speak],
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
