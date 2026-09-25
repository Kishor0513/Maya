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
  const glow = ACCENTS[accent] ?? ACCENTS.violet;
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
    <div className="maya-noise relative flex h-full min-h-[100dvh] overflow-hidden bg-[#050505] text-white">
      {/* Ambient cinematic background */}
      {ambient && (
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-[-20%] h-[60vh] w-[90vw] -translate-x-1/2 rounded-full blur-[120px]"
            style={{ background: `radial-gradient(closest-side, ${glow.ambientA}, transparent)` }} />
          <div className="absolute bottom-[-25%] left-[8%] h-[50vh] w-[50vw] rounded-full blur-[120px]"
            style={{ background: `radial-gradient(closest-side, ${glow.ambientB}, transparent)` }} />
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
        {/* Header */}
        <header className="flex shrink-0 items-center justify-between gap-3 px-4 pt-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebar(true)}
              aria-label="Open conversations"
              className="rounded-full border border-white/10 bg-white/[0.05] p-2.5 text-zinc-300 hover:bg-white/10 lg:hidden"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <p className="font-display text-xl italic lg:hidden">Maya</p>
          </div>
          <div className="flex items-center gap-2">
            <ConnectionIndicator status={connection} />
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              title="Settings"
              className="rounded-full border border-white/10 bg-white/[0.05] p-2.5 text-zinc-300 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.6.7 1 1.32 1H21a2 2 0 1 1 0 4h-.09c-.53 0-1.06.4-1.51 1Z" />
              </svg>
            </button>
          </div>
        </header>

        {/* Stage */}
        <div className="flex shrink-0 justify-center px-4 pt-1">
          <div
            role="tablist"
            aria-label="Talk or chat"
            className="flex rounded-full border border-white/10 bg-white/[0.05] p-1 backdrop-blur"
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
                className={`rounded-full px-5 py-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${
                  view === t.id
                    ? 'bg-violet-300/90 font-medium text-black'
                    : 'text-zinc-400 hover:text-white'
                }`}
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

          <div className="min-h-[3.5rem] max-w-xl">
            <p aria-live="polite" className="font-display text-2xl italic text-zinc-100 sm:text-[1.7rem]">
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
              className="rounded-full border border-white/10 px-4 py-1.5 text-xs text-zinc-400 hover:bg-white/5 hover:text-white"
            >
              New conversation
            </button>
            <button
              onClick={() => setTranscriptOpen((v) => !v)}
              aria-expanded={transcriptOpen}
              className="rounded-full border border-white/10 px-4 py-1.5 text-xs text-zinc-400 hover:bg-white/5 hover:text-white"
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
              setMicOn(true);
              void engine.processTurn(t);
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
    </div>
  );
}
