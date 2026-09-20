import { useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';

// First-run onboarding: meet → mic → name. Short by design.
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const userName = useSettingsStore((s) => s.userName);
  const update = useSettingsStore((s) => s.update);
  const [name, setName] = useState(userName);

  return (
    <div role="dialog" aria-modal="true" aria-label="Meet Maya" className="fixed inset-0 z-50 grid place-items-center bg-[#050505]/95 backdrop-blur p-4">
      <div className="w-full max-w-md text-center">
        {step === 0 && (
          <>
            <div aria-hidden className="mx-auto h-24 w-24 rounded-full mb-6"
              style={{ background: 'conic-gradient(from 120deg, #C4B5FD, #F9A8D4, #2A2A35, #C4B5FD)', boxShadow: '0 0 80px -12px rgba(196,181,253,0.5)' }} />
            <h1 className="font-display text-5xl italic text-white">Maya</h1>
            <p className="mt-3 text-lg text-zinc-300">Hi, I'm Maya.</p>
            <p className="mt-1 text-sm text-zinc-500">You can talk to me naturally. No typing required.</p>
            <button onClick={() => setStep(1)} autoFocus
              className="mt-8 rounded-full bg-violet-300 px-8 py-3 text-sm font-medium text-black hover:bg-violet-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-200">
              Meet Maya
            </button>
          </>
        )}
        {step === 1 && (
          <>
            <h2 className="font-display text-4xl italic text-white">A quick hello needs your mic</h2>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              Maya listens so you can just talk. Your browser will ask for permission —
              audio goes to your configured backend only.
            </p>
            <div className="mt-8 flex gap-2 justify-center">
              <button onClick={() => setStep(2)}
                className="rounded-full border border-white/10 px-6 py-2.5 text-sm text-zinc-300 hover:bg-white/5">Skip</button>
              <button onClick={() => setStep(2)} autoFocus
                className="rounded-full bg-violet-300 px-6 py-2.5 text-sm font-medium text-black hover:bg-violet-200">Continue</button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h2 className="font-display text-4xl italic text-white">What should I call you?</h2>
            <label htmlFor="onboard-name" className="sr-only">Your name</label>
            <input
              id="onboard-name" value={name} autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') finish(); }}
              placeholder="Your name"
              className="mt-6 w-full rounded-2xl border border-white/10 bg-white/[0.05] px-5 py-3.5 text-center text-lg text-white placeholder:text-zinc-600 focus:outline-none focus:border-violet-300/50"
            />
            <button onClick={finish}
              className="mt-4 w-full rounded-full bg-violet-300 py-3 text-sm font-medium text-black hover:bg-violet-200">
              Start talking
            </button>
          </>
        )}
      </div>
    </div>
  );

  function finish() {
    update('userName', name.trim());
    update('onboarded', true);
    onDone();
  }
}
