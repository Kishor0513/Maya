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
import type { ConversationContext } from '../types';

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
    try {
      await textToSpeech.speak(text, {
        rate: s.voice.speed * ve.speed,
        pitch: s.voice.pitch * ve.pitch,
        voiceId: s.voice.voiceId || undefined,
        emotion: ve,
      });
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
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || processingRef.current) return;
      processingRef.current = true;
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      const st = useConversationStore.getState();
      let activeId = st.activeId;
      if (!activeId) activeId = st.newConversation();

      // User message
      st.appendMessage({ conversationId: activeId, role: 'user', text });
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
        const finalText = full.trim() || "Hmm — I lost that thought. Say it once more?";
        useConversationStore.getState().updateMessage(placeholder.id, {
          text: finalText,
          partial: false,
        });
        useConversationStore.getState().setPartialMaya('');
        useMayaStore.getState().setAvatarOverride(null);
        useMayaStore.getState().pushMayaTurn(finalText);
        await speak(finalText);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Request failed';
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
        onPartial: (t) => useConversationStore.getState().setPartialUser(t),
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
    const t =
      speechToText.lastTranscript ||
      useConversationStore.getState().partialUser.trim();
    // In auto mode with Web Speech continuous dictation, finals arrive via
    // onFinal; VAD end is the nudge to send what we have.
    if (t.trim().length > 1) {
      const frozen = speechToText.stop();
      useConversationStore.getState().setPartialUser('');
      void processTurn(frozen || t);
      // Resume listening after the turn completes (speak() restores state).
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
