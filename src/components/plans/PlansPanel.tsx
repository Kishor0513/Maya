import { useState } from 'react';
import {
  listReminders,
  cancelReminder,
  listEvents,
  cancelEvent,
  describeWhen,
} from '../../services/tools/MayaTools';

// Plans panel — upcoming reminders + calendar events (both local).
export function PlansPanel({ onClose }: { onClose: () => void }) {
  const [rev, setRev] = useState(0);
  void rev;
  const reminders = listReminders();
  const events = listEvents();
  const refresh = () => setRev((x) => x + 1);

  return (
    <div role="dialog" aria-modal="true" aria-label="Plans" className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md max-h-[84vh] overflow-y-auto rounded-3xl border border-white/10 bg-[#0B0B0F] p-6 shadow-soft">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-3xl italic text-white">Plans</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Ask Maya to “remind me…” or save an event — it lands here.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close plans" className="rounded-full p-2 text-zinc-500 hover:text-white">✕</button>
        </div>

        <h3 className="mt-5 mb-2 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          Reminders ({reminders.length})
        </h3>
        {reminders.length === 0 ? (
          <p className="text-sm text-zinc-600">None. Try “remind me to stretch in 10 minutes”.</p>
        ) : (
          <ul className="space-y-2">
            {reminders.map((r) => (
              <Row key={r.id} title={r.text} sub={describeWhen(r.at)} onCancel={() => { cancelReminder(r.id); refresh(); }} />
            ))}
          </ul>
        )}

        <h3 className="mt-5 mb-2 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          Events ({events.length})
        </h3>
        {events.length === 0 ? (
          <p className="text-sm text-zinc-600">None yet.</p>
        ) : (
          <ul className="space-y-2">
            {events.map((e) => (
              <Row key={e.id} title={e.title} sub={describeWhen(e.at)} onCancel={() => { cancelEvent(e.id); refresh(); }} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Row({ title, sub, onCancel }: { title: string; sub: string; onCancel: () => void }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm text-zinc-100">{title}</p>
        <p className="text-[11px] text-zinc-600">{sub}</p>
      </div>
      <button onClick={onCancel} className="shrink-0 rounded-full px-2.5 py-1 text-[11px] text-zinc-400 hover:text-rose-300 hover:bg-white/5">
        Cancel
      </button>
    </li>
  );
}
