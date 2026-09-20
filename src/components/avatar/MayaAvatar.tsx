import { useMemo } from 'react';
import type { MayaAvatarProps, MayaState } from '../../types';
import { cx } from '../../utils/format';

/**
 * MayaAvatar — layered CSS/canvas avatar, deterministic from props.
 * Base portrait (gradient orb) + ambient glow + breathing + state + emotion.
 */
export function MayaAvatar({ state, inputLevel, outputLevel, emotion }: MayaAvatarProps) {
  const level = state === 'listening' ? inputLevel : state === 'speaking' ? outputLevel : 0;

  const palette = useMemo(() => {
    switch (state) {
      case 'happy':
      case 'excited':
      case 'playful':
        return { a: '#F9A8D4', b: '#C4B5FD', glow: 'rgba(249,168,212,0.5)', dim: 1 };
      case 'sad':
        return { a: '#64748B', b: '#475569', glow: 'rgba(100,116,139,0.35)', dim: 0.72 };
      case 'concerned':
        return { a: '#FDA4AF', b: '#A78BFA', glow: 'rgba(253,164,175,0.4)', dim: 0.9 };
      case 'curious':
      case 'processing':
        return { a: '#93C5FD', b: '#C4B5FD', glow: 'rgba(147,197,253,0.45)', dim: 0.95 };
      case 'listening':
        return { a: '#DDD6FE', b: '#F9A8D4', glow: 'rgba(196,181,253,0.55)', dim: 1 };
      case 'speaking':
        return { a: '#C4B5FD', b: '#F0ABFC', glow: 'rgba(196,181,253,0.6)', dim: 1 };
      default:
        return { a: '#B9A8F9', b: '#7C7C9A', glow: 'rgba(196,181,253,0.35)', dim: 0.92 };
    }
  }, [state]);

  const animDuration = useMemo(() => {
    if (state === 'excited') return '1.6s';
    if (state === 'sad') return '7s';
    if (state === 'speaking') return '1.1s';
    return '5s';
  }, [state]);

  const scale = 1 + Math.min(0.5, level) * (state === 'excited' ? 0.16 : 0.09);
  const warmth = emotion.affection > 0.6 ? 0.25 : 0;

  return (
    <div
      role="img"
      aria-label={`Maya is ${state}`}
      className="relative mx-auto h-56 w-56 select-none sm:h-64 sm:w-64"
      style={{ opacity: palette.dim }}
    >
      {/* Ambient glow */}
      <div
        aria-hidden
        className={cx(
          'absolute inset-[-28%] rounded-full blur-3xl transition-all duration-500',
          state === 'processing' && 'animate-pulseGlow',
        )}
        style={{
          background: `radial-gradient(circle at 50% 45%, ${palette.glow}, transparent 65%)`,
          opacity: 0.55 + Math.min(0.45, level * 1.4),
          transform: `scale(${0.95 + Math.min(0.4, level) * 0.5})`,
        }}
      />
      {/* Breathing core */}
      <div
        aria-hidden
        className="absolute inset-0 rounded-full animate-breathe"
        style={{ animationDuration: animDuration }}
      >
        <div
          className="absolute inset-[6%] rounded-full transition-transform duration-300"
          style={{
            transform: `scale(${scale})`,
            background: `conic-gradient(from 120deg, ${palette.a}, ${palette.b}, #2A2A35, ${palette.a})`,
            filter: `saturate(${1 + warmth})`,
            boxShadow: `0 0 90px -18px ${palette.glow}, inset 0 0 60px rgba(0,0,0,0.55)`,
          }}
        />
        {/* Inner portrait light */}
        <div
          className="absolute inset-[18%] rounded-full"
          style={{
            background:
              'radial-gradient(circle at 38% 32%, rgba(255,255,255,0.85), rgba(255,255,255,0.12) 34%, rgba(5,5,5,0.35) 62%, rgba(5,5,5,0.85) 100%)',
            opacity: 0.5 + Math.min(0.5, level),
          }}
        />
        {/* Speaking ripple rings */}
        {(state === 'speaking' || state === 'excited') && (
          <div
            aria-hidden
            className="absolute inset-[2%] rounded-full border"
            style={{
              borderColor: 'rgba(255,255,255,0.18)',
              transform: `scale(${1 + Math.min(0.4, level) * 0.35})`,
              opacity: 0.4 + level,
            }}
          />
        )}
        {/* Listening brighten */}
        {state === 'listening' && (
          <div
            aria-hidden
            className="absolute inset-[10%] rounded-full border border-white/25"
            style={{ opacity: 0.35 + inputLevel * 1.2, transform: `scale(${1 + inputLevel * 0.12})` }}
          />
        )}
      </div>
      {/* State caption for screen readers + subtle label */}
      <span className="sr-only">{stateLabel(state)}</span>
    </div>
  );
}

function stateLabel(s: MayaState): string {
  switch (s) {
    case 'listening':
      return 'listening to you';
    case 'processing':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    default:
      return s;
  }
}
