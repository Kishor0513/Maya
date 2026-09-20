import { create } from 'zustand';
import type { MayaError } from '../types';

interface VoiceStore {
  micPermission: 'unknown' | 'granted' | 'denied' | 'prompt';
  micActive: boolean;
  vadSpeaking: boolean;
  pushHeld: boolean;
  lastError: MayaError | null;
  setMicPermission: (p: VoiceStore['micPermission']) => void;
  setMicActive: (v: boolean) => void;
  setVadSpeaking: (v: boolean) => void;
  setPushHeld: (v: boolean) => void;
  setLastError: (e: MayaError | null) => void;
}

export const useVoiceStore = create<VoiceStore>((set) => ({
  micPermission: 'unknown',
  micActive: false,
  vadSpeaking: false,
  pushHeld: false,
  lastError: null,
  setMicPermission: (micPermission) => set({ micPermission }),
  setMicActive: (micActive) => set({ micActive }),
  setVadSpeaking: (vadSpeaking) => set({ vadSpeaking }),
  setPushHeld: (pushHeld) => set({ pushHeld }),
  setLastError: (lastError) => set({ lastError }),
}));
