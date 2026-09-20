import type { MayaState } from '../../types';
import { cx } from '../../utils/format';

// VoiceOrb — compact orb used in headers / mobile bars.
export function VoiceOrb({
  state,
  level,
  size = 40,
}: {
  state: MayaState;
  level: number;
  size?: number;
}) {
  const active = state === 'listening' || state === 'speaking';
  return (
    <div
      aria-hidden
      className={cx('relative rounded-full', active && 'animate-pulseGlow')}
      style={{ width: size, height: size }}
    >
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: 'conic-gradient(from 90deg, #C4B5FD, #F9A8D4, #2c2c38, #C4B5FD)',
          transform: `scale(${1 + Math.min(0.5, level) * 0.3})`,
          boxShadow: '0 0 24px -4px rgba(196,181,253,0.6)',
          transition: 'transform 120ms linear',
        }}
      />
      <div
        className="absolute rounded-full bg-[#0B0B0F]"
        style={{ inset: size * 0.22 }}
      />
    </div>
  );
}
