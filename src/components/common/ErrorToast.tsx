import type { MayaError } from '../../types';

const ADVICE: Record<MayaError['code'], string> = {
  'mic-denied': 'Allow microphone access in your browser, then try again.',
  network: 'Check your connection.',
  'ws-closed': 'The realtime channel dropped.',
  'ai-timeout': 'The AI took too long to respond.',
  'tts-failure': 'Voice playback failed; text still works.',
  'stt-failure': 'Could not transcribe speech.',
  'invalid-key': 'Backend credentials look wrong. Check server config.',
  'rate-limit': 'Slow down a little, then retry.',
  'backend-unavailable': 'The backend gateway is unreachable. Demo mode still works.',
  'unsupported-browser': 'Use a recent Chrome, Edge, Safari or Firefox.',
  unknown: 'Something unexpected happened.',
};

export function ErrorToast({
  error,
  onDismiss,
  onReconnect,
}: {
  error: MayaError | null;
  onDismiss: () => void;
  onReconnect?: () => void;
}) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="fixed bottom-6 left-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 rounded-2xl border border-rose-300/20 bg-[#14090d]/95 backdrop-blur-xl p-4 shadow-soft"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 h-2.5 w-2.5 rounded-full bg-rose-400" />
        <div className="flex-1">
          <p className="text-sm font-medium text-rose-100">I lost the connection for a moment.</p>
          <p className="mt-1 text-xs text-zinc-400">
            {error.message} {ADVICE[error.code]}
          </p>
          <div className="mt-3 flex gap-2">
            {error.recoverable && onReconnect && (
              <button
                type="button"
                onClick={onReconnect}
                className="rounded-full bg-white/10 px-3.5 py-1.5 text-xs text-white hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-200"
              >
                Reconnect
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-full px-3.5 py-1.5 text-xs text-zinc-400 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
