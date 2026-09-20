// Voice Activity Detection — energy-based with hysteresis + hangover.
// Runs on rAF, reads levels from AudioManager (no React state per sample).

export interface VadOptions {
  sensitivity: number; // 0..1 (higher = easier to trigger)
  silenceMs: number; // trailing silence before "speech-end"
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onLevel?: (level: number) => void;
}

export class VoiceActivityDetector {
  private raf = 0;
  private running = false;
  private speaking = false;
  private lastVoiceAt = 0;
  private lastLevel = 0;
  private getLevel: () => number;
  private opts: Required<Omit<VadOptions, 'onLevel'>> & Pick<VadOptions, 'onLevel'>;

  constructor(getLevel: () => number, opts: VadOptions) {
    this.getLevel = getLevel;
    this.opts = {
      sensitivity: opts.sensitivity,
      silenceMs: opts.silenceMs,
      onSpeechStart: opts.onSpeechStart ?? (() => undefined),
      onSpeechEnd: opts.onSpeechEnd ?? (() => undefined),
      onLevel: opts.onLevel,
    };
  }

  update(opts: Partial<VadOptions>): void {
    if (opts.sensitivity !== undefined) this.opts.sensitivity = opts.sensitivity;
    if (opts.silenceMs !== undefined) this.opts.silenceMs = opts.silenceMs;
    if (opts.onSpeechStart) this.opts.onSpeechStart = opts.onSpeechStart;
    if (opts.onSpeechEnd) this.opts.onSpeechEnd = opts.onSpeechEnd;
    if (opts.onLevel) this.opts.onLevel = opts.onLevel;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Threshold mapped from sensitivity: 0.9 sens → ~0.06 level. */
  private threshold(): { start: number; stop: number } {
    const s = Math.min(1, Math.max(0, this.opts.sensitivity));
    const start = 0.22 - s * 0.17; // 0.22 .. 0.05
    return { start, stop: start * 0.55 };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      const raw = this.getLevel();
      // Light smoothing to reject single-frame spikes.
      this.lastLevel = this.lastLevel * 0.6 + raw * 0.4;
      this.opts.onLevel?.(this.lastLevel);
      const { start, stop } = this.threshold();
      const now = performance.now();
      if (!this.speaking && this.lastLevel > start) {
        this.speaking = true;
        this.lastVoiceAt = now;
        this.opts.onSpeechStart();
      } else if (this.speaking) {
        if (this.lastLevel > stop) {
          this.lastVoiceAt = now;
        } else if (now - this.lastVoiceAt >= this.opts.silenceMs) {
          this.speaking = false;
          this.opts.onSpeechEnd();
        }
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.speaking) {
      this.speaking = false;
      this.opts.onSpeechEnd();
    }
  }
}
