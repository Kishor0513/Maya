import { useCallback, useEffect, useState } from 'react';
import { MayaAvatar } from '../components/avatar/MayaAvatar';
import { AudioWaveform } from '../components/waveform/AudioWaveform';
import { VoiceButton } from '../components/voice/VoiceButton';
import { ConversationTranscript } from '../components/chat/ConversationTranscript';
import { ChatView } from '../components/chat/ChatView';
import { ChatInput } from '../components/chat/ChatInput';
import { ConnectionIndicator } from '../components/common/ConnectionIndicator';
import { ErrorToast } from '../components/common/ErrorToast';
import { PermissionDialog } from '../components/common/PermissionDialog';
import { Onboarding } from '../components/common/Onboarding';
import { ConversationSidebar } from '../components/sidebar/ConversationSidebar';
import { SettingsPanel } from '../components/settings/SettingsPanel';
import { MemoryPanel } from '../components/memory/MemoryPanel';
import { DocsPanel } from '../components/memory/DocsPanel';
import { PlansPanel } from '../components/plans/PlansPanel';
import { AuthGate } from '../components/common/AuthGate';
import { ApprovalDialog } from '../components/common/ApprovalDialog';
import { ACCENTS } from '../features/appearance/accents';
import {
  pullConversations,
  pushConversation,
  subscribeSync,
  peekOutbox,
  clearOutbox,
  checkDeliveredReminders,
} from '../services/sync';
import { trackEvent } from '../services/analytics';
import { initReminders } from '../services/tools/MayaTools';
import { useAuthStore } from '../stores/authStore';
import { useConversationEngine } from '../hooks/useConversation';
import { useVoiceActivity } from '../hooks/useVoiceActivity';
import { useRealtime } from '../hooks/useRealtime';
import { speechToText } from '../services/speech/SpeechToText';
import { useConversationStore } from '../stores/conversationStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useMayaStore } from '../stores/mayaStore';
import { useVoiceStore } from '../stores/voiceStore';
import { STATE_LABEL } from '../features/conversation/machine';
import { Analytics } from '@vercel/analytics/react';

type View = 'talk' | 'chat';

function initialView(): View {
  try {
    const q = new URLSearchParams(window.location.search).get('view');
    if (q === 'chat' || q === 'talk') return q;
    const saved = localStorage.getItem('maya.view.v1');
    if (saved === 'chat' || saved === 'talk') return saved;
  } catch {
    /* non-browser env — fall through */
  }
  return 'talk';
}

export function App() {
  const engine = useConversationEngine();
  useRealtime();

  const convState = useConversationStore((s) => s.convState);
  const connection = useConversationStore((s) => s.connection);
  const error = useConversationStore((s) => s.error);
  const setError = useConversationStore((s) => s.setError);
  const partialUser = useConversationStore((s) => s.partialUser);
  const partialMaya = useConversationStore((s) => s.partialMaya);
  const messages = useConversationStore((s) => s.activeConversation()?.messages ?? []);
  const newConversation = useConversationStore((s) => s.newConversation);

  const voiceMode = useSettingsStore((s) => s.voiceMode);
  const vadEnabled = useSettingsStore((s) => s.audio.vadEnabled);
  const onboarded = useSettingsStore((s) => s.onboarded);
  const ambient = useSettingsStore((s) => s.appearance.ambientEffects);
  const accent = useSettingsStore((s) => s.appearance.accent);
  const avatarStyle = useSettingsStore((s) => s.appearance.avatarStyle);
  const themePref = useSettingsStore((s) => s.appearance.theme);
  const animationsOn = useSettingsStore((s) => s.appearance.animations);
  const glow = ACCENTS[accent] ?? ACCENTS.violet;
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window === 'undefined' ||
      !window.matchMedia ||
      window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const isLight = themePref === 'light' || (themePref === 'system' && !systemDark);
  const userName = useSettingsStore((s) => s.userName);

  const avatarState = useMayaStore((s) => s.avatarState);
  const emotion = useMayaStore((s) => s.emotion);
  const inputLevel = useMayaStore((s) => s.inputLevel);
  const outputLevel = useMayaStore((s) => s.outputLevel);
  const micPermission = useVoiceStore((s) => s.micPermission);

  const [sidebar, setSidebar] = useState(false);
  // View is deep-linkable (?view=chat) and persisted, so reaching Chat never
  // depends on a single button working.
  const [view, setView] = useState<'talk' | 'chat'>(() => initialView());
  const switchView = useCallback((v: 'talk' | 'chat') => {
    setView(v);
    try {
      localStorage.setItem('maya.view.v1', v);
    } catch {
      /* private mode — non-fatal */
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('view', v);
      window.history.replaceState(null, '', url);
    } catch {
      /* non-browser env — ignore */
    }
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  const authRequired = useAuthStore((s) => s.required);
  const authToken = useAuthStore((s) => s.token);
  const probeAuth = useAuthStore((s) => s.probe);

  useEffect(() => {
    void probeAuth();
    initReminders();
  }, [probeAuth]);

  // Cloud sync (only when signed in): pull on login, push debounced edits,
  // realtime updates, delivered-reminder announcements, offline-outbox flush.
  useEffect(() => {
    if (!authToken) return;
    void pullConversations();
    void checkDeliveredReminders();
    let pushTimer: number | undefined;
    const unsubStore = useConversationStore.subscribe((s) => {
      const id = s.activeId;
      if (!id) return;
      window.clearTimeout(pushTimer);
      pushTimer = window.setTimeout(() => void pushConversation(id), 3000);
    });
    const unsubSync = subscribeSync(
      () => void pullConversations(),
      () => void checkDeliveredReminders(),
    );
    const flushOutbox = async () => {
      if (!navigator.onLine) return;
      const items = peekOutbox();
      if (items.length === 0) return;
      clearOutbox(items.map((i) => i.id));
      for (const item of items.slice(0, 5)) {
        await engine.processTurn(item.text, item.images ?? []);
      }
    };
    window.addEventListener('online', flushOutbox);
    void flushOutbox();
    return () => {
      window.clearTimeout(pushTimer);
      unsubStore();
      unsubSync();
      window.removeEventListener('online', flushOutbox);
    };
  }, [authToken, engine]);
  const [permOpen, setPermOpen] = useState(false);
  const [micOn, setMicOn] = useState(false);

  // VAD-driven natural conversation: active once mic is on + auto mode.
  useVoiceActivity({
    enabled: micOn && vadEnabled && voiceMode === 'auto',
    onSpeechStart: engine.handleVadStart,
    onSpeechEnd: engine.handleVadEnd,
  });

  const ensureTalking = useCallback(async () => {
    if (micPermission === 'denied') {
      setPermOpen(true);
      return false;
    }
    const ok = await engine.ensureMic();
    if (!ok) {
      setPermOpen(true);
      return false;
    }
    setMicOn(true);
    return true;
  }, [engine, micPermission]);

  const handleMainButton = useCallback(async () => {
    // Tap while Maya speaks → interrupt.
    if (convState === 'speaking') {
      engine.interrupt();
      return;
    }
    if (convState === 'listening' && speechToText.isListening) {
      engine.stopListeningAndSend();
      return;
    }
    const ok = await ensureTalking();
    if (!ok) return;
    await engine.startListening();
  }, [convState, engine, ensureTalking]);

  // Ctrl+K focuses search, Ctrl+N new conversation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSidebar(true);
        setTimeout(() => document.getElementById('conv-search')?.focus(), 80);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const statusText =
    convState === 'connected' && messages.length === 0
      ? userName
        ? `Hey ${userName}. I'm here — just start talking.`
        : 'You can talk to me about anything.'
      : STATE_LABEL[convState];

  const lastMayaText = [...messages].reverse().find((m) => m.role === 'assistant')?.text;

  return (
    <div className={`maya-noise relative flex h-full min-h-[100dvh] overflow-hidden bg-[#050505] text-white${isLight ? ' theme-light' : ''}${animationsOn ? '' : ' no-anim'}`}>
      {/* Aurora cinematic background */}
      {ambient && (
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute left-1/2 top-[-25%] h-[65vh] w-[95vw] -translate-x-1/2 rounded-full blur-[110px]"
            style={{ background: `radial-gradient(closest-side, ${glow.ambientA}, transparent)` }} />
          <div className="absolute bottom-[-30%] left-[-10%] h-[55vh] w-[60vw] rounded-full blur-[110px]"
            style={{ background: `radial-gradient(closest-side, ${glow.ambientB}, transparent)` }} />
          <div className="absolute right-[-15%] top-[30%] h-[45vh] w-[40vw] rounded-full blur-[130px] opacity-70"
            style={{ background: `radial-gradient(closest-side, ${glow.ambientA}, transparent)` }} />
        </div>
      )}

      <ConversationSidebar
        open={sidebar}
        onClose={() => setSidebar(false)}
        onOpenSettings={() => { setSidebar(false); setSettingsOpen(true); }}
        onOpenMemory={() => { setSidebar(false); setMemoryOpen(true); }}
        onOpenDocs={() => { setSidebar(false); setDocsOpen(true); }}
        onOpenPlans={() => { setSidebar(false); setPlansOpen(true); }}
      />

      <main className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {/* Header — floating glass pill */}
        <header className="z-10 flex shrink-0 justify-center px-3 pt-3 sm:px-6 sm:pt-4">
          <div className="glass-panel flex w-full max-w-2xl items-center justify-between gap-2 rounded-full py-1.5 pl-2 pr-1.5">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebar(true)}
              aria-label="Open conversations"
              className="icon-btn h-9 w-9 lg:hidden"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <p className="font-display text-xl italic lg:hidden">Maya</p>
            <p className="font-display hidden text-xl italic lg:block">Maya</p>
          </div>
          <div className="flex items-center gap-2">
            <ConnectionIndicator status={connection} />
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              title="Settings"
              className="icon-btn h-9 w-9"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.6.7 1 1.32 1H21a2 2 0 1 1 0 4h-.09c-.53 0-1.06.4-1.51 1Z" />
              </svg>
            </button>
          </div>
          </div>
        </header>

        {/* Stage */}
        <div className="flex shrink-0 justify-center px-4 pt-2">
          <div
            role="tablist"
            aria-label="Talk or chat"
            className="seg shadow-soft"
          >
            {(
              [
                { id: 'talk', label: 'Talk' },
                { id: 'chat', label: 'Chat' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={view === t.id}
                onClick={() => switchView(t.id)}
                className="focus-visible:ring-2 focus-visible:ring-violet-300 focus:outline-none"
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {view === 'talk' ? (
        // Scrolls internally (m-auto keeps it centered when space allows)
        // so the input bar below is never pushed off-screen.
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="m-auto flex w-full flex-col items-center gap-4 px-4 py-5 text-center sm:gap-5">
          <MayaAvatar
            state={avatarState}
            inputLevel={inputLevel}
            outputLevel={outputLevel}
            emotion={emotion}
            accent={accent}
            variant={avatarStyle}
          />

          <div className="min-h-[4rem] max-w-xl px-2">
            <p aria-live="polite" className="font-display text-3xl italic leading-tight text-zinc-100 sm:text-4xl">
              {convState === 'processing' ? 'Thinking…' : statusText}
            </p>
            {partialUser && convState === 'listening' && (
              <p className="mt-1 text-sm italic text-zinc-500">“{partialUser}”</p>
            )}
            {!partialUser && lastMayaText && convState !== 'processing' && messages.length > 0 && !transcriptOpen && (
              <p className="mx-auto mt-1 line-clamp-2 max-w-md text-sm text-zinc-500">“{lastMayaText}”</p>
            )}
          </div>

          <AudioWaveform
            inputLevel={inputLevel}
            outputLevel={outputLevel}
            state={convState}
            from={glow.wave[0]}
            to={glow.wave[1]}
            className="w-full max-w-md"
          />

          <VoiceButton
            convState={convState}
            voiceMode={voiceMode}
            micPermission={micPermission}
            onTap={handleMainButton}
            onHoldStart={async () => {
              const ok = await ensureTalking();
              if (ok) await engine.startListening();
            }}
            onHoldEnd={() => engine.stopListeningAndSend()}
          />

          <div className="flex items-center gap-2">
            <button
              onClick={() => { newConversation(); }}
              title="New conversation (Ctrl+N)"
              className="btn-ghost px-4 py-1.5 text-xs"
            >
              New conversation
            </button>
            <button
              onClick={() => setTranscriptOpen((v) => !v)}
              aria-expanded={transcriptOpen}
              className="btn-ghost px-4 py-1.5 text-xs"
            >
              {transcriptOpen ? 'Hide transcript' : 'Conversation'}
            </button>
          </div>

          <ConversationTranscript
            messages={messages}
            partialUser={partialUser}
            partialMaya={partialMaya}
            open={transcriptOpen}
          />
        </div>
        </div>
        ) : (
        <div className="flex min-h-0 flex-1 flex-col px-4 sm:px-6">
          <ChatView
            messages={messages}
            partialUser={partialUser}
            convState={convState}
            onSuggestion={(t) => {
              trackEvent('message_sent', { mode: 'suggestion' });
              setMicOn(true);
              void engine.processTurn(t, [], 'suggestion');
            }}
          />
        </div>
        )}

        {/* Bottom input — pinned, never squeezed out */}
        <footer className="shrink-0 px-4 pb-5 sm:px-6">
          <ChatInput
            onSend={(t, images) => {
              if (engine.isProcessing()) return false;
              setMicOn(true);
              void engine.processTurn(t, images);
              return true;
            }}
            disabled={convState === 'processing'}
            placeholder={view === 'chat' ? 'Message Maya…  (Enter to send)' : 'Type something…  (Enter to send)'}
          />
        </footer>
      </main>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {memoryOpen && <MemoryPanel onClose={() => setMemoryOpen(false)} />}
      {docsOpen && <DocsPanel onClose={() => setDocsOpen(false)} />}
      {plansOpen && <PlansPanel onClose={() => setPlansOpen(false)} />}
      {authRequired && !authToken && <AuthGate />}
      <ApprovalDialog />
      <PermissionDialog
        open={permOpen}
        onAllow={async () => { setPermOpen(false); const ok = await engine.ensureMic(); if (ok) setMicOn(true); }}
        onDismiss={() => setPermOpen(false)}
      />
      <ErrorToast
        error={error}
        onDismiss={() => setError(null)}
        onReconnect={() => { setError(null); window.location.reload(); }}
      />
      {!onboarded && <Onboarding onDone={() => undefined} />}
      <Analytics />
    </div>
  );
}
