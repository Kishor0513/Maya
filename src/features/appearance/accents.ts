export type AccentId = 'violet' | 'ocean' | 'ember';

export interface Accent {
  /** Primary hue (avatar core, glows). */
  a: string;
  /** Secondary hue (ambient warmth, waveform head). */
  b: string;
  glow: string;
  /** 'r,g,b' triplets for canvas gradients. */
  wave: [string, string];
  ambientA: string;
  ambientB: string;
  label: string;
}

export const ACCENTS: Record<AccentId, Accent> = {
  violet: {
    a: '#C4B5FD',
    b: '#F9A8D4',
    glow: 'rgba(196,181,253,0.5)',
    wave: ['249,168,212', '196,181,253'],
    ambientA: 'rgba(124,93,250,0.22)',
    ambientB: 'rgba(249,168,212,0.12)',
    label: 'Violet',
  },
  ocean: {
    a: '#7DD3FC',
    b: '#A5B4FC',
    glow: 'rgba(125,211,252,0.5)',
    wave: ['125,211,252', '165,180,252'],
    ambientA: 'rgba(56,130,246,0.22)',
    ambientB: 'rgba(125,211,252,0.12)',
    label: 'Ocean',
  },
  ember: {
    a: '#FDBA74',
    b: '#FDA4AF',
    glow: 'rgba(253,186,116,0.5)',
    wave: ['253,186,116', '253,164,175'],
    ambientA: 'rgba(249,115,22,0.20)',
    ambientB: 'rgba(253,164,175,0.12)',
    label: 'Ember',
  },
};
