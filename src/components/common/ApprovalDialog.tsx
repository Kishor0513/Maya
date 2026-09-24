import { useComputerStore } from '../../stores/computerStore';

// Approval dialog: Maya proposes a computer action, the user allows or denies.
// Nothing pre-approved runs except read-only commands (user toggle) — the
// gateway blocklist refuses destructive patterns unconditionally.
export function ApprovalDialog() {
  const pending = useComputerStore((s) => s.pending);
  const resolveApproval = useComputerStore((s) => s.resolveApproval);
  if (!pending) return null;

  const riskColor =
    pending.risk === 'system'
      ? 'text-rose-300 border-rose-300/30'
      : pending.risk === 'write'
        ? 'text-amber-200 border-amber-200/30'
        : 'text-emerald-300 border-emerald-300/30';

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={`Allow ${pending.tool}?`}
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4"
    >
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0B0B0F] p-6 shadow-soft">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-2xl italic text-white">Let Maya do this?</h2>
          <span className={`rounded-full border px-2.5 py-0.5 text-[11px] uppercase tracking-widest ${riskColor}`}>
            {pending.risk}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-400">{pending.title}</p>
        <pre className="mt-3 max-h-40 overflow-auto rounded-2xl border border-white/10 bg-black/50 p-3 text-[13px] leading-relaxed text-zinc-100 whitespace-pre-wrap break-words">
          {pending.detail}
        </pre>
        {pending.warning && (
          <p className="mt-2 text-xs leading-relaxed text-rose-200/90">{pending.warning}</p>
        )}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            autoFocus
            onClick={() => resolveApproval(false)}
            className="flex-1 rounded-full border border-white/10 py-2.5 text-sm text-zinc-300 hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => resolveApproval(true)}
            className="flex-1 rounded-full bg-violet-300 py-2.5 text-sm font-medium text-black hover:bg-violet-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-200"
          >
            Allow once
          </button>
        </div>
        <p className="mt-3 text-center text-[11px] text-zinc-600">
          Destructive patterns are refused automatically and never ask.
        </p>
      </div>
    </div>
  );
}
