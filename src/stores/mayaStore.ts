import { create } from 'zustand';
import type {
  EmotionalState,
  MayaState,
  RelationshipState,
} from '../types';
import { NEUTRAL_EMOTION, nextEmotion, detectSignals, emotionToAvatarState } from '../features/personality/engine';

interface MayaStore {
  avatarState: MayaState;
  baseActivity: 'idle' | 'listening' | 'processing' | 'speaking';
  emotion: EmotionalState;
  relationship: RelationshipState;
  inputLevel: number;
  outputLevel: number;
  ttsActive: boolean;
  setActivity: (a: MayaStore['baseActivity']) => void;
  setAvatarOverride: (s: MayaState | null) => void;
  pushUserTurn: (text: string) => void;
  pushMayaTurn: (text: string) => void;
  setLevels: (input: number, output: number) => void;
  setTtsActive: (v: boolean) => void;
  loadRelationship: () => void;
}

let avatarOverride: MayaState | null = null;

function storedRelationship(): RelationshipState {
  try {
    const raw = localStorage.getItem('maya.relationship.v1');
    if (raw) return JSON.parse(raw) as RelationshipState;
  } catch {
    /* ignore */
  }
  return {
    familiarity: 0.05,
    trust: 0.1,
    conversationCount: 0,
    sharedTopics: [],
    importantMoments: [],
  };
}

function persistRelationship(r: RelationshipState): void {
  try {
    localStorage.setItem('maya.relationship.v1', JSON.stringify(r));
  } catch {
    /* ignore */
  }
}

function resolveAvatar(
  base: MayaStore['baseActivity'],
  emotion: EmotionalState,
): MayaState {
  if (avatarOverride) return avatarOverride;
  return emotionToAvatarState(base, emotion);
}

export const useMayaStore = create<MayaStore>((set, get) => ({
  avatarState: 'idle',
  baseActivity: 'idle',
  emotion: NEUTRAL_EMOTION,
  relationship: storedRelationship(),
  inputLevel: 0,
  outputLevel: 0,
  ttsActive: false,

  setActivity: (baseActivity) =>
    set((st) => ({ baseActivity, avatarState: resolveAvatar(baseActivity, st.emotion) })),
  setAvatarOverride: (s) => {
    avatarOverride = s;
    if (s) set({ avatarState: s });
    else {
      const st = get();
      set({ avatarState: resolveAvatar(st.baseActivity, st.emotion) });
    }
  },
  pushUserTurn: (text) =>
    set((st) => {
      const emotion = nextEmotion(st.emotion, detectSignals(text));
      const relationship: RelationshipState = {
        ...st.relationship,
        familiarity: Math.min(1, st.relationship.familiarity + 0.01),
        trust: Math.min(1, st.relationship.trust + 0.005),
      };
      persistRelationship(relationship);
      return { emotion, relationship, avatarState: resolveAvatar(st.baseActivity, emotion) };
    }),
  pushMayaTurn: (text) =>
    set((st) => {
      const emotion = nextEmotion(st.emotion, detectSignals(text));
      void text;
      return { emotion, avatarState: resolveAvatar(st.baseActivity, emotion) };
    }),
  setLevels: (inputLevel, outputLevel) => set({ inputLevel, outputLevel }),
  setTtsActive: (ttsActive) => set({ ttsActive }),
  loadRelationship: () => set({ relationship: storedRelationship() }),
}));
