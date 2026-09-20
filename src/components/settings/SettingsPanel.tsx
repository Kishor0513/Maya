import { useState } from 'react';
import type { ReactNode } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useConversationStore } from '../../stores/conversationStore';
import { memoryService } from '../../services/memory/MemoryService';
import { textToSpeech } from '../../services/speech/TextToSpeech';

export function VoiceSettings() {
  const voice = useSettingsStore((s) => s.voice);
  const updateNested = useSettingsStore((s) => s.updateNested);
  const [voices] = useState(() => textToSpeech.voices());

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="voice-select" className="text-xs uppercase tracking-widest text-zinc-500">Voice</label>
        <select
          id="voice-select"
          value={voice.voiceId}
          onChange={(e) => updateNested('voice', { voiceId: e.target.value })}
          className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-300/50"
        >
          <option value="">Maya — Warm (default)</option>
          <option value="calm">Maya — Calm</option>
          <option value="energetic">Maya — Energetic</option>
          {voices.slice(0, 20).map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name} ({v.lang})
            </option>
          ))}
        </select>
      </div>
      <Slider label="Speaking speed" value={voice.speed} min={0.7} max={1.3} step={0.01}
        onChange={(v) => updateNested('voice', { speed: v })} />
      <Slider label="Pitch" value={voice.pitch} min={0.8} max={1.2} step={0.01}
        onChange={(v) => updateNested('voice', { pitch: v })} />
      <Slider label="Expressiveness" value={voice.expressiveness} min={0} max={1} step={0.01}
        onChange={(v) => updateNested('voice', { expressiveness: v })} />
    </div>
  );
}

export function Slider({
  label, value, min, max, step, onChange, hint,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; hint?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="text-xs uppercase tracking-widest text-zinc-500">{label}</label>
        <span className="text-xs text-zinc-400 tabular-nums">{value.toFixed(2)}</span>
      </div>
      {hint && <p className="text-[11px] text-zinc-600 mt-0.5">{hint}</p>}
      <input
        type="range" aria-label={label}
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="maya-range mt-1.5 w-full"
      />
    </div>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const s = useSettingsStore();
  const conv = useConversationStore();
  const [confirmClear, setConfirmClear] = useState(false);

  return (
    <div role="dialog" aria-modal="true" aria-label="Settings" className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-xl max-h-[86vh] overflow-y-auto rounded-3xl border border-white/10 bg-[#0B0B0F] p-6 shadow-soft">
        <div className="flex items-start justify-between">
          <h2 className="font-display text-3xl italic text-white">Settings</h2>
          <button onClick={onClose} aria-label="Close settings" className="rounded-full p-2 text-zinc-500 hover:text-white">✕</button>
        </div>

        <Section title="AI Provider">
          <span className="text-xs uppercase tracking-widest text-zinc-500">Provider</span>
          <div className="mt-1.5 w-full rounded-xl border border-violet-300/30 bg-violet-300/[0.08] px-3 py-2.5 text-sm text-white">
            Google Gemini <span className="text-zinc-400">— Maya&apos;s brain</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="model" className="text-xs uppercase tracking-widest text-zinc-500">Model</label>
              <input id="model" value={s.ai.model} onChange={(e) => s.updateNested('ai', { model: e.target.value })}
                className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white" />
            </div>
            <div>
              <label htmlFor="endpoint" className="text-xs uppercase tracking-widest text-zinc-500">API endpoint</label>
              <input id="endpoint" value={s.ai.endpoint} onChange={(e) => s.updateNested('ai', { endpoint: e.target.value })}
                placeholder="/api" className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white" />
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
            Your Gemini key stays on your backend gateway — the browser only talks to `/api`.
            Never paste a vendor API key here.
          </p>
        </Section>

        <Section title="Voice">
          <VoiceSettings />
        </Section>

        <Section title="Conversation">
          <Toggle label="Auto-listen after Maya speaks" checked={s.conversation.autoListen}
            onChange={(v) => s.updateNested('conversation', { autoListen: v })} />
          <Toggle label="Let me interrupt Maya" checked={s.conversation.allowInterrupt}
            onChange={(v) => s.updateNested('conversation', { allowInterrupt: v })} />
          <Toggle label="Auto-play voice responses" checked={s.conversation.autoPlayResponses}
            onChange={(v) => { s.updateNested('conversation', { autoPlayResponses: v }); s.updateNested('voice', { autoPlay: v }); }} />
          <div className="mt-3">
            <label className="text-xs uppercase tracking-widest text-zinc-500" htmlFor="vmode">Microphone mode</label>
            <select id="vmode" value={s.voiceMode} onChange={(e) => s.update('voiceMode', e.target.value as typeof s.voiceMode)}
              className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white">
              <option value="auto">Auto conversation (VAD)</option>
              <option value="push-to-talk">Push to talk</option>
              <option value="manual">Manual recording</option>
            </select>
          </div>
        </Section>

        <Section title="Voice Activity Detection">
          <Toggle label="VAD enabled" checked={s.audio.vadEnabled}
            onChange={(v) => s.updateNested('audio', { vadEnabled: v })} />
          <div className="mt-3">
            <Slider label="Sensitivity" value={s.audio.vadSensitivity} min={0.1} max={0.95} step={0.01}
              onChange={(v) => s.updateNested('audio', { vadSensitivity: v })} />
            <Slider label="Silence before sending (ms)" value={s.audio.silenceMs} min={300} max={2000} step={50}
              onChange={(v) => s.updateNested('audio', { silenceMs: v })} />
          </div>
        </Section>

        <Section title="Language">
          <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Language">
            {([['auto', 'Auto'], ['en', 'English'], ['ne', 'नेपाली'], ['hi', 'हिन्दी']] as const).map(([v, label]) => (
              <button key={v} role="radio" aria-checked={s.ai.language === v}
                onClick={() => s.updateNested('ai', { language: v })}
                className={`rounded-full border py-2 text-sm ${s.ai.language === v ? 'border-violet-300/60 bg-violet-300/15 text-white' : 'border-white/10 text-zinc-400 hover:bg-white/5'}`}>
                {label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Appearance">
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
            {(['dark', 'light', 'system'] as const).map((t) => (
              <button key={t} role="radio" aria-checked={s.appearance.theme === t}
                onClick={() => s.updateNested('appearance', { theme: t })}
                className={`rounded-full border py-2 text-sm capitalize ${s.appearance.theme === t ? 'border-violet-300/60 bg-violet-300/15 text-white' : 'border-white/10 text-zinc-400 hover:bg-white/5'}`}>
                {t}
              </button>
            ))}
          </div>
          <div className="mt-2">
            <Toggle label="Ambient effects" checked={s.appearance.ambientEffects}
              onChange={(v) => s.updateNested('appearance', { ambientEffects: v })} />
            <Toggle label="Animations" checked={s.appearance.animations}
              onChange={(v) => s.updateNested('appearance', { animations: v })} />
          </div>
        </Section>

        <Section title="Memory & Privacy">
          <Toggle label="Long-term memory" checked={s.privacy.memoryEnabled}
            onChange={(v) => s.updateNested('privacy', { memoryEnabled: v })} />
          <Toggle label="Store conversations on this device" checked={s.privacy.storeConversations}
            onChange={(v) => s.updateNested('privacy', { storeConversations: v })} />
          <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-zinc-400 space-y-1">
            <p>Microphone: <StatusDot /> {micLabel()}</p>
            <p>Conversation storage: {s.privacy.storeConversations ? 'Enabled (this device)' : 'Disabled'}</p>
            <p>Long-term memory: {s.privacy.memoryEnabled ? 'Enabled' : 'Disabled'}</p>
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={() => memoryService.clear()}
              className="flex-1 rounded-full border border-white/10 py-2 text-xs text-zinc-300 hover:bg-white/5">Clear memories</button>
            {!confirmClear ? (
              <button onClick={() => setConfirmClear(true)}
                className="flex-1 rounded-full border border-rose-300/20 py-2 text-xs text-rose-200 hover:bg-rose-300/10">Clear history…</button>
            ) : (
              <button onClick={() => { conv.clearAllConversations(); setConfirmClear(false); }}
                className="flex-1 rounded-full bg-rose-400/90 py-2 text-xs font-medium text-black">Confirm clear</button>
            )}
          </div>
        </Section>

        <Section title="Advanced">
          <label className="text-xs uppercase tracking-widest text-zinc-500" htmlFor="yourname">What should Maya call you?</label>
          <input id="yourname" value={s.userName} onChange={(e) => s.update('userName', e.target.value)}
            placeholder="Your name" className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white" />
          <p className="mt-3 text-[11px] text-zinc-600">Keyboard: Space push-to-talk · Esc stop · Ctrl/⌘+K search · Ctrl/⌘+N new chat</p>
        </Section>
      </div>
    </div>
  );

  function micLabel(): string {
    return 'managed by browser permission';
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 border-t border-white/[0.07] pt-4">
      <h3 className="mb-3 text-[11px] uppercase tracking-[0.2em] text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-zinc-200">{label}</span>
      <button role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 rounded-full transition-colors ${checked ? 'bg-violet-300' : 'bg-white/15'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </div>
  );
}

function StatusDot() {
  return <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 align-middle" />;
}
