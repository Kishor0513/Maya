// Voice picking — Maya is female-presenting, so unless the user chose a
// specific voice we default to a female-sounding English system voice
// instead of whatever the OS happens to list first (often male).

const FEMALE_RE =
  /samantha|karen|moira|tessa|fiona|veena|lekha|zira|aria|jenny|michelle|emma|allison|olivia|sophia|amelia|harper|evelyn|serena|hazel|susan|kyoko|google us english|google uk english female/i;

interface VoiceLike {
  name: string;
  lang: string;
  localService: boolean;
  default?: boolean;
}

export function scoreVoice(v: VoiceLike): number {
  let s = 0;
  const lang = (v.lang || '').toLowerCase();
  if (lang.startsWith('en')) s += 10;
  if (lang === 'en-us' || lang === 'en_us') s += 2;
  if (FEMALE_RE.test(v.name)) s += 20;
  if (v.localService) s += 1;
  if (v.default) s += 1;
  return s;
}

export function pickMayaVoice<T extends VoiceLike>(
  voices: T[],
  voiceId?: string,
): T | null {
  if (voices.length === 0) return null;
  if (voiceId) {
    const exact = (voices as (T & { voiceURI?: string })[]).find(
      (v) => v.voiceURI === voiceId || v.name === voiceId,
    );
    if (exact) return exact;
  }
  let best: T | null = null;
  let bestScore = -1;
  for (const v of voices) {
    const s = scoreVoice(v);
    if (s > bestScore) {
      bestScore = s;
      best = v;
    }
  }
  return best;
}
