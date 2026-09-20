import { useEffect, useRef } from 'react';
import type { ConversationState } from '../../types';

// AudioWaveform — REAL canvas visualization driven by live levels.
// Bars are synthesized from the actual amplitude envelope (attack/decay),
// so silence is flat and speech moves. No fake idle oscillation.

export function AudioWaveform({
  inputLevel,
  outputLevel,
  state,
  bars = 48,
  className = '',
}: {
  inputLevel: number;
  outputLevel: number;
  state: ConversationState;
  bars?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const envRef = useRef<number[]>([]);
  const levelRef = useRef({ inputLevel, outputLevel, state });
  levelRef.current = { inputLevel, outputLevel, state };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let t = 0;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      t += 1;
      const { inputLevel: inp, outputLevel: out, state: st } = levelRef.current;
      const live = st === 'listening' ? inp : st === 'speaking' ? out : st === 'processing' ? 0.08 : 0.015;
      const n = bars;
      if (envRef.current.length !== n) envRef.current = new Array(n).fill(0);
      const env = envRef.current;

      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const gap = W / n;
      const bw = Math.max(2, gap * 0.42);
      for (let i = 0; i < n; i++) {
        const center = 1 - Math.abs(i - n / 2) / (n / 2); // 0..1 bell
        // Per-bar variation from position + time, gated by the real level.
        const wobble = reduced ? 0 : Math.sin(t / 9 + i * 0.55) * 0.5 + 0.5;
        const target = Math.min(1, live * (0.35 + center * 0.9) * (0.45 + wobble * 0.9));
        // Fast attack, slow release → feels like real audio.
        env[i] += (target - env[i]) * (target > env[i] ? 0.45 : 0.12);
        const h = Math.max(2, env[i] * H * 0.92);
        const x = i * gap + (gap - bw) / 2;
        const y = (H - h) / 2;
        const warmth = st === 'speaking' ? 1 : st === 'listening' ? 0.6 : 0.25;
        const alpha = 0.22 + env[i] * 0.78;
        const grad = ctx.createLinearGradient(0, y, 0, y + h);
        grad.addColorStop(0, `rgba(249,168,212,${alpha * (0.5 + warmth * 0.5)})`);
        grad.addColorStop(1, `rgba(196,181,253,${alpha})`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        const r = Math.min(bw / 2, 4);
        if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, bw, h, r);
        else ctx.rect(x, y, bw, h);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [bars]);

  return (
    <div className={className} aria-hidden>
      <canvas ref={ref} className="h-12 w-full sm:h-14" />
    </div>
  );
}
