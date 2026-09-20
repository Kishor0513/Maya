import { useMemo, useState } from 'react';
import { memoryService } from '../../services/memory/MemoryService';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Memory } from '../../types';

const CATEGORY_LABEL: Record<Memory['type'], string> = {
  profile: 'About you',
  preference: 'Preferences',
  project: 'Projects',
  interest: 'Interests',
  person: 'People',
  event: 'Events',
  goal: 'Goals',
  fact: 'Facts',
};

export function MemoryPanel({ onClose }: { onClose: () => void }) {
  const memoryEnabled = useSettingsStore((s) => s.privacy.memoryEnabled);
  const updateNested = useSettingsStore((s) => s.updateNested);
  const [rev, setRev] = useState(0);
  const refresh = () => setRev((x) => x + 1);
  // Local-first store has no subscription; rev + memoryEnabled invalidate the cache.
  const memories = useMemo(() => {
    void rev;
    void memoryEnabled;
    return memoryService.all();
  }, [memoryEnabled, rev]);

  const groups = useMemo(() => {
    const g = new Map<string, Memory[]>();
    for (const m of memories) {
      const k = CATEGORY_LABEL[m.type] ?? m.type;
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(m);
    }
    return [...g.entries()];
  }, [memories]);

  return (
    <div role="dialog" aria-modal="true" aria-label="Maya remembers" className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg max-h-[84vh] overflow-y-auto rounded-3xl border border-white/10 bg-[#0B0B0F] p-6 shadow-soft">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-3xl italic text-white">Maya remembers</h2>
            <p className="mt-1 text-sm text-zinc-500">Inspect, correct, or forget anything.</p>
          </div>
          <button onClick={onClose} aria-label="Close memory" className="rounded-full p-2 text-zinc-500 hover:text-white">✕</button>
        </div>

        <label className="mt-4 flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm">
          <span className="text-zinc-200">Long-term memory</span>
          <button
            role="switch"
            aria-checked={memoryEnabled}
            onClick={() => updateNested('privacy', { memoryEnabled: !memoryEnabled })}
            className={`relative h-6 w-11 rounded-full transition-colors ${memoryEnabled ? 'bg-violet-300' : 'bg-white/15'}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${memoryEnabled ? 'left-[22px]' : 'left-0.5'}`} />
          </button>
        </label>

        {groups.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-500">
            Nothing stored yet. Tell Maya your name, what you're working on, or what you like —
            she'll remember the important bits.
          </p>
        ) : (
          <div className="mt-4 space-y-5">
            {groups.map(([label, items]) => (
              <section key={label}>
                <h3 className="text-[11px] uppercase tracking-[0.18em] text-zinc-500 mb-2">{label}</h3>
                <ul className="space-y-2">
                  {items.map((m) => (
                    <MemoryRow key={m.id} memory={m} refresh={refresh} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {memories.length > 0 && (
          <button
            onClick={() => { memoryService.clear(); refresh(); }}
            className="mt-6 w-full rounded-full border border-rose-300/20 py-2.5 text-sm text-rose-200 hover:bg-rose-300/10"
          >
            Forget everything
          </button>
        )}
      </div>
    </div>
  );
}

function MemoryRow({ memory, refresh }: { memory: Memory; refresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(memory.value);
  return (
    <li className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
      {editing ? (
        <div className="flex gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`Edit ${memory.key}`}
            className="flex-1 rounded-lg bg-black/40 border border-white/10 px-3 py-1.5 text-sm text-white focus:outline-none focus:border-violet-300/50"
          />
          <button
            onClick={() => { memoryService.update(memory.id, { value }); setEditing(false); refresh(); }}
            className="rounded-full bg-violet-300 px-3 py-1 text-xs font-medium text-black"
          >
            Save
          </button>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-zinc-100">• {memory.value}</p>
            <p className="mt-0.5 text-[11px] text-zinc-600">{memory.key.replace(/_/g, ' ')} · {Math.round(memory.confidence * 100)}%</p>
          </div>
          <div className="flex shrink-0 gap-1">
            <button onClick={() => { setValue(memory.value); setEditing(true); }} className="rounded-full px-2.5 py-1 text-[11px] text-zinc-400 hover:text-white hover:bg-white/5">Edit</button>
            <button onClick={() => { memoryService.remove(memory.id); refresh(); }} className="rounded-full px-2.5 py-1 text-[11px] text-zinc-400 hover:text-rose-300 hover:bg-white/5">Forget</button>
          </div>
        </div>
      )}
    </li>
  );
}
