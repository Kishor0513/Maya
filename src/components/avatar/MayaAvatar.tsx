import { useMemo } from 'react';
import type { MayaAvatarProps, MayaState } from '../../types';
import { cx } from '../../utils/format';
import { ACCENTS } from '../../features/appearance/accents';

/**
 * MayaAvatar — layered avatar, deterministic from props.
 * State drives mood (glow strength, dimming, motion); the accent theme
 * drives hue; the variant drives geometry (orb / halo / prism).
 */
export function MayaAvatar({
  state,
  inputLevel,
  outputLevel,
  emotion,
  accent = 'violet',
  variant = 'orb',
}: MayaAvatarProps) {
  const A = ACCENTS[accent] ?? ACCENTS.violet;
  const level = state === 'listening' ? inputLevel : state === 'speaking' ? outputLevel : 0;

  const mood = useMemo(() => {
    switch (state) {
      case 'happy':
      case 'excited':
      case 'playful':
        return { a: A.b, b: A.a, glow: A.glow, dim: 1 };
      case 'sad':
        return { a: '#64748B', b: '#475569', glow: 'rgba(100,116,139,0.35)', dim: 0.72 };
      case 'concerned':
        return { a: A.b, b: '#A78BFA', glow: A.glow, dim: 0.9 };
      case 'curious':
      case 'processing':
        return { a: '#93C5FD', b: A.a, glow: 'rgba(147,197,253,0.45)', dim: 0.95 };
      case 'listening':
        return { a: '#DDD6FE', b: A.b, glow: A.glow, dim: 1 };
      case 'speaking':
        return { a: A.a, b: A.b, glow: A.glow, dim: 1 };
      default:
        return { a: A.a, b: '#7C7C9A', glow: A.glow, dim: 0.92 };
    }
  }, [state, A]);

  const animDuration = useMemo(() => {
    if (state === 'excited') return '1.6s';
    if (state === 'sad') return '7s';
    if (state === 'speaking') return '1.1s';
    return '5s';
  }, [state]);

  const scale = 1 + Math.min(0.5, level) * (state === 'excited' ? 0.16 : 0.09);
  const warmth = emotion.affection > 0.6 ? 0.25 : 0;

  const coreBackground =
    variant === 'prism'
      ? `conic-gradient(from 40deg, ${mood.a}, ${mood.b}, #1c1c28, ${mood.b}, ${mood.a})`
      : variant === 'halo'
        ? `radial-gradient(circle at 50% 42%, ${mood.a}, ${mood.b} 55%, #1a1a24 100%)`
        : `conic-gradient(from 120deg, ${mood.a}, ${mood.b}, #2A2A35, ${mood.a})`;

  return (
    <div
      role="img"
      aria-label={`Maya is ${state}`}
      className="relative mx-auto h-56 w-56 select-none sm:h-64 sm:w-64"
      style={{ opacity: mood.dim }}
    >
      {/* Ambient glow */}
      <div
        aria-hidden
        className={cx(
          'absolute inset-[-28%] rounded-full blur-3xl transition-all duration-500',
          state === 'processing' && 'animate-pulseGlow',
        )}
        style={{
          background: `radial-gradient(circle at 50% 45%, ${mood.glow}, transparent 65%)`,
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
          className={cx(
            'absolute rounded-full transition-transform duration-300',
            variant === 'halo' ? 'inset-[14%]' : 'inset-[6%]',
            variant === 'prism' && 'maya-spin-slow',
          )}
          style={{
            transform: `scale(${scale})`,
            background: coreBackground,
            ...(variant === 'prism'
              ? { animation: 'maya-spin 26s linear infinite' }
              : undefined),
            filter: `saturate(${1 + warmth})`,
            boxShadow: `0 0 90px -18px ${mood.glow}, inset 0 0 60px rgba(0,0,0,0.55)`,
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
        {(state === 'speaking' || state === 'excited' || variant === 'halo') && (
          <div
            aria-hidden
            className="absolute inset-[2%] rounded-full border"
            style={{
              borderColor: variant === 'halo' ? mood.a : 'rgba(255,255,255,0.18)',
              opacity: variant === 'halo' ? 0.7 : 0.4 + level,
              transform: `scale(${1 + Math.min(0.4, level) * 0.35})`,
              ...(variant === 'halo' ? { borderWidth: 2 } : undefined),
            }}
          />
        )}
        {variant === 'halo' && (
          <div
            aria-hidden
            className="absolute inset-[-4%] rounded-full border"
            style={{ borderColor: mood.b, opacity: 0.3 }}
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
