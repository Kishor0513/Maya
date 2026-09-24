import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppSettings } from '../types';

const DEFAULTS: AppSettings = {
  appearance: { theme: 'dark', ambientEffects: true, animations: true, accent: 'violet', avatarStyle: 'orb' },
  voice: { voiceId: '', speed: 1.02, pitch: 1, expressiveness: 0.7, autoPlay: true },
  audio: { vadEnabled: true, vadSensitivity: 0.65, silenceMs: 800 },
  ai: {
    provider: 'gemini',
    model: 'gemini-3.6-flash',
    endpoint: '',
    language: 'auto',
  },
  conversation: { autoListen: true, allowInterrupt: true, autoPlayResponses: true, wakeWord: false, streamSpeech: true, autoApproveReads: true },
  privacy: { storeConversations: true, memoryEnabled: true },
  voiceMode: 'auto',
  userName: '',
  onboarded: false,
};

interface SettingsStore extends AppSettings {
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  updateNested: <K extends keyof AppSettings>(
    section: K,
    patch: Partial<AppSettings[K]>,
  ) => void;
  reset: () => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      update: (key, value) => set({ [key]: value } as Partial<SettingsStore>),
      updateNested: (section, patch) =>
        set((st) => ({
          [section]: { ...(st[section] as unknown as Record<string, unknown>), ...patch },
        }) as unknown as Partial<SettingsStore>),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'maya.settings.v1',
      version: 5,
      // Single-brain app: every stored install converges on Gemini.
      // The model is forced (retired providers' names would fail), and a
      // legacy default endpoint of '/api' becomes '' so split hosting
      // (Vercel + VITE_API_URL) resolves automatically. Explicit custom
      // endpoints are preserved.
      migrate: (state: unknown) => {
        const s = (state as Partial<SettingsStore> | undefined) ?? {};
        const prev = (s.ai ?? {}) as Partial<AppSettings['ai']>;
        const endpoint = prev.endpoint && prev.endpoint !== '/api' ? prev.endpoint : '';
        return {
          ...s,
          ai: {
            provider: 'gemini',
            model: 'gemini-3.6-flash',
            endpoint,
            language: prev.language ?? 'auto',
          },
        } as SettingsStore;
      },
    },
  ),
);

export function sttLang(language: AppSettings['ai']['language']): string {
  switch (language) {
    case 'ne':
      return 'ne-NP';
    case 'hi':
      return 'hi-IN';
    default:
      return 'en-US';
  }
}
