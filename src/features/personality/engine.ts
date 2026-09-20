import type { EmotionalState, MayaState } from '../../types';

// Emotion engine — values drift gradually toward targets derived from
// conversation signals. Never random jumps.

export const NEUTRAL_EMOTION: EmotionalState = {
  mood: 0.25,
  energy: 0.5,
  affection: 0.45,
  curiosity: 0.55,
  excitement: 0.3,
  concern: 0,
};

export function nextEmotion(
  prev: EmotionalState,
  signals: {
    userJoy?: boolean;
    userSad?: boolean;
    userAffection?: boolean;
    interestingTopic?: boolean;
    farewell?: boolean;
    conflict?: boolean;
  },
): EmotionalState {
  const t: EmotionalState = { ...prev };
  if (signals.userJoy) {
    t.mood += 0.12;
    t.excitement += 0.15;
    t.energy += 0.08;
  }
  if (signals.userSad) {
    t.concern += 0.2;
    t.mood -= 0.06;
    t.affection += 0.1;
    t.energy -= 0.06;
  }
  if (signals.userAffection) t.affection += 0.12;
  if (signals.interestingTopic) t.curiosity += 0.14;
  if (signals.farewell) {
    t.mood -= 0.04;
    t.affection += 0.05;
  }
  if (signals.conflict) {
    t.concern += 0.1;
    t.excitement -= 0.05;
  }
  // Decay toward baseline so states are moods, not latches.
  const out: EmotionalState = {
    mood: drift(t.mood, NEUTRAL_EMOTION.mood, 0.06, -1, 1),
    energy: drift(t.energy, NEUTRAL_EMOTION.energy, 0.04, 0, 1),
    affection: drift(t.affection, NEUTRAL_EMOTION.affection, 0.02, 0, 1),
    curiosity: drift(t.curiosity, NEUTRAL_EMOTION.curiosity, 0.03, 0, 1),
    excitement: drift(t.excitement, NEUTRAL_EMOTION.excitement, 0.08, 0, 1),
    concern: drift(t.concern, NEUTRAL_EMOTION.concern, 0.07, 0, 1),
  };
  return out;
}

function drift(v: number, base: number, rate: number, lo: number, hi: number): number {
  const d = v + (base - v) * rate;
  return Math.min(hi, Math.max(lo, d));
}

export function detectSignals(text: string): Parameters<typeof nextEmotion>[1] {
  const t = text.toLowerCase();
  return {
    userJoy: /(haha|lol|😂|funny|awesome|great news|yay|love it)/i.test(t),
    userSad: /(sad|terrible|awful|lonely|anxious|scared|depress|grief|tired|stress|cry)/i.test(t),
    userAffection: /(thank|love you|miss you|appreciate|धन्यवाद|माया)/i.test(t),
    interestingTopic: /(why|how does|explain|what if|philosoph|physics|code|design|history)/i.test(t),
    farewell: /(goodbye|bye|good night|see you|जान्छु)/i.test(t),
    conflict: /(you'?re wrong|shut up|stupid|hate you|idiot)/i.test(t),
  };
}

/** Map conversation/emotion to avatar expression layer. */
export function emotionToAvatarState(
  conv: 'listening' | 'processing' | 'speaking' | 'idle',
  e: EmotionalState,
): MayaState {
  if (conv !== 'idle') return conv;
  if (e.excitement > 0.65) return 'excited';
  if (e.concern > 0.5) return 'concerned';
  if (e.curiosity > 0.7) return 'curious';
  if (e.mood > 0.55 && e.affection > 0.55) return 'happy';
  if (e.mood < -0.25) return 'sad';
  if (e.affection > 0.65) return 'playful';
  return 'idle';
}
