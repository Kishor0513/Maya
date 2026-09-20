export function PermissionDialog({
  open,
  onAllow,
  onDismiss,
}: {
  open: boolean;
  onAllow: () => void;
  onDismiss: () => void;
}) {
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Microphone permission" className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#0B0B0F] p-6 text-center shadow-soft">
        <div aria-hidden className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-violet-300/15">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#C4B5FD" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <rect x="9" y="2.5" width="6" height="11" rx="3" fill="#C4B5FD" stroke="none" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <path d="M12 18v3.5" />
          </svg>
        </div>
        <h2 className="font-display text-2xl text-white">Maya needs your microphone</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          Voice conversations need microphone access. Audio is streamed to your configured
          backend only — never to a vendor directly from this page.
        </p>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="flex-1 rounded-full border border-white/10 py-2.5 text-sm text-zinc-300 hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={onAllow}
            autoFocus
            className="flex-1 rounded-full bg-violet-300 py-2.5 text-sm font-medium text-black hover:bg-violet-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-200"
          >
            Allow microphone
          </button>
        </div>
      </div>
    </div>
  );
}
