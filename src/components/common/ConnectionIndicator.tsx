import type { ConnectionStatus } from '../../types';
import { cx } from '../../utils/format';

const META: Record<ConnectionStatus, { dot: string; label: string }> = {
  connecting: { dot: 'bg-amber-300', label: 'Connecting…' },
  connected: { dot: 'bg-emerald-400', label: 'Maya is online' },
  reconnecting: { dot: 'bg-amber-300 animate-pulse', label: 'Reconnecting…' },
  offline: { dot: 'bg-zinc-500', label: 'Offline' },
  error: { dot: 'bg-rose-400', label: 'Connection error' },
};

export function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const m = META[status];
  return (
    <div
      role="status"
      aria-label={m.label}
      title={m.label}
      className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] backdrop-blur px-3 py-1.5"
    >
      <span className={cx('h-2 w-2 rounded-full', m.dot)} aria-hidden />
      <span className="text-xs text-zinc-300">{m.label}</span>
    </div>
  );
}
