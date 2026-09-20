import { useRef } from 'react';
import type { ConversationState, VoiceMode } from '../../types';
import { cx } from '../../utils/format';

export function VoiceButton({
  convState,
  voiceMode,
  micPermission,
  onTap,
  onHoldStart,
  onHoldEnd,
}: {
  convState: ConversationState;
  voiceMode: VoiceMode;
  micPermission: string;
  onTap: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
}) {
  const holdTimer = useRef<number | null>(null);
  const holding = useRef(false);

  const active = convState === 'listening' || convState === 'processing' || convState === 'speaking';
  const label =
    convState === 'listening'
      ? 'Listening — release to send'
      : convState === 'processing'
        ? 'Thinking…'
        : convState === 'speaking'
          ? 'Speaking — tap to interrupt'
          : voiceMode === 'push-to-talk'
            ? 'Hold to talk'
            : 'Tap to talk';

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        aria-label={micPermission === 'denied' ? 'Microphone blocked — open settings' : label}
        title={voiceMode === 'push-to-talk' ? 'Hold Space or hold click (Push-to-talk)' : 'Tap to talk (Space)'}
        onClick={() => {
          if (convState === 'speaking') {
            onTap(); // tap while speaking = interrupt affordance handled by parent
            return;
          }
          if (voiceMode !== 'push-to-talk') onTap();
        }}
        onPointerDown={() => {
          if (voiceMode !== 'push-to-talk') return;
          holding.current = false;
          holdTimer.current = window.setTimeout(() => {
            holding.current = true;
            onHoldStart();
          }, 120);
        }}
        onPointerUp={() => {
          if (voiceMode !== 'push-to-talk') return;
          if (holdTimer.current) clearTimeout(holdTimer.current);
          if (holding.current) {
            holding.current = false;
            onHoldEnd();
          }
        }}
        onPointerLeave={() => {
          if (voiceMode !== 'push-to-talk') return;
          if (holdTimer.current) clearTimeout(holdTimer.current);
          if (holding.current) {
            holding.current = false;
            onHoldEnd();
          }
        }}
        onKeyDown={(e) => {
          if (e.code === 'Space' && voiceMode === 'push-to-talk' && !e.repeat) {
            e.preventDefault();
            onHoldStart();
          }
        }}
        onKeyUp={(e) => {
          if (e.code === 'Space' && voiceMode === 'push-to-talk') {
            e.preventDefault();
            onHoldEnd();
          }
        }}
        className={cx(
          'group relative grid h-20 w-20 place-items-center rounded-full transition-all duration-200',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black',
          active
            ? 'bg-gradient-to-br from-violet-300 to-pink-300 text-black shadow-glow scale-105'
            : 'bg-white/[0.07] text-white hover:bg-white/[0.12] border border-white/10 shadow-soft',
        )}
      >
        {active && (
          <span aria-hidden className="absolute inset-[-6px] rounded-full border border-violet-300/30 animate-ping [animation-duration:1.8s]" />
        )}
        <MicIcon speaking={convState === 'speaking'} />
      </button>
      <p className="text-sm text-zinc-400" aria-live="polite">
        {label}
      </p>
    </div>
  );
}

function MicIcon({ speaking }: { speaking: boolean }) {
  if (speaking) {
    // Stop square while Maya speaks (tap to interrupt)
    return (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <rect x="6" y="6" width="12" height="12" rx="2.5" />
      </svg>
    );
  }
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2.5" width="6" height="11" rx="3" fill="currentColor" stroke="none" opacity="0.9" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3.5" />
    </svg>
  );
}
