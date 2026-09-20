// AudioManager — owns mic capture, analysis, and output playback.
// Keeps all AudioContext / MediaStream cleanup in one place.

import { pickMayaVoice } from '../speech/voices';

export interface LevelSnapshot {
  input: number; // 0..1 mic amplitude
  output: number; // 0..1 playback amplitude
}

const noop = () => undefined;

export class AudioManager {
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  private outGain: GainNode | null = null;
  private playbackNodes = new Set<AudioBufferSourceNode>();
  private ttsUtterance: SpeechSynthesisUtterance | null = null;
  private destroyed = false;

  private micTime = new Uint8Array(0);
  private outTime = new Uint8Array(0);

  get available(): boolean {
    return (
      typeof window !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      (window.AudioContext !== undefined ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext !== undefined)
    );
  }

  initialize(): AudioContext {
    if (!this.ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.outGain = this.ctx.createGain();
      this.outAnalyser = this.ctx.createAnalyser();
      this.outAnalyser.fftSize = 1024;
      this.outAnalyser.smoothingTimeConstant = 0.75;
      this.outGain.connect(this.outAnalyser);
      this.outAnalyser.connect(this.ctx.destination);
      this.outTime = new Uint8Array(this.outAnalyser.fftSize);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(noop);
    return this.ctx;
  }

  async requestMicrophone(deviceId?: string): Promise<MediaStream> {
    this.initialize();
    if (this.micStream) return this.micStream;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.attachMic(stream);
    return stream;
  }

  attachMic(stream: MediaStream): void {
    this.initialize();
    this.detachMic(false);
    this.micStream = stream;
    if (!this.ctx) return;
    this.micSource = this.ctx.createMediaStreamSource(stream);
    this.micAnalyser = this.ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.micAnalyser.smoothingTimeConstant = 0.7;
    this.micSource.connect(this.micAnalyser);
    this.micTime = new Uint8Array(this.micAnalyser.fftSize);
  }

  getMicStream(): MediaStream | null {
    return this.micStream;
  }

  /** RMS amplitude 0..1 for the given analyser. */
  private rms(analyser: AnalyserNode | null, buf: Uint8Array): number {
    if (!analyser || !this.ctx) return 0;
    analyser.getByteTimeDomainData(buf as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 2) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (buf.length / 2));
    // Gentle curve so quiet speech is visible but silence stays ~0.
    return Math.min(1, rms * 3.2);
  }

  getInputLevel(): number {
    if (!this.micAnalyser) return 0;
    if (this.micTime.length !== this.micAnalyser.fftSize)
      this.micTime = new Uint8Array(this.micAnalyser.fftSize);
    return this.rms(this.micAnalyser, this.micTime);
  }

  getOutputLevel(): number {
    if (!this.outAnalyser) return 0;
    if (this.outTime.length !== this.outAnalyser.fftSize)
      this.outTime = new Uint8Array(this.outAnalyser.fftSize);
    return this.rms(this.outAnalyser, this.outTime);
  }

  getLevels(): LevelSnapshot {
    return { input: this.getInputLevel(), output: this.getOutputLevel() };
  }

  /** Queue a raw PCM-16 or provider-decoded chunk through the output chain. */
  async playAudioChunk(data: ArrayBuffer): Promise<void> {
    this.initialize();
    if (!this.ctx || !this.outGain || this.destroyed) return;
    try {
      const copy = data.slice(0);
      const buf = await this.ctx.decodeAudioData(copy);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.outGain);
      this.playbackNodes.add(src);
      src.onended = () => this.playbackNodes.delete(src);
      src.start();
    } catch {
      // Non-audio chunk (or unsupported codec) — ignore silently.
    }
  }

  /** Speak text via system TTS routed visually through output analyser approximation. */
  speakWithSystemTTS(
    text: string,
    opts: { rate: number; pitch: number; voiceId?: string; onEnd?: () => void } ,
  ): void {
    if (!('speechSynthesis' in window)) {
      opts.onEnd?.();
      return;
    }
    this.stopPlayback();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = opts.rate;
    u.pitch = opts.pitch;
    const voices = window.speechSynthesis.getVoices();
    const match = pickMayaVoice(voices, opts.voiceId);
    if (match) u.voice = match;
    u.onend = () => {
      if (this.ttsUtterance === u) this.ttsUtterance = null;
      opts.onEnd?.();
    };
    u.onerror = () => {
      if (this.ttsUtterance === u) this.ttsUtterance = null;
      opts.onEnd?.();
    };
    this.ttsUtterance = u;
    window.speechSynthesis.speak(u);
  }

  /** Approximate output level while system TTS speaks (no tap available). */
  ttsPseudoLevel(active: boolean, t: number): number {
    if (!active) return 0;
    return 0.35 + 0.3 * Math.abs(Math.sin(t / 180)) + 0.1 * Math.abs(Math.sin(t / 61));
  }

  stopPlayback(): void {
    for (const n of this.playbackNodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    this.playbackNodes.clear();
    if ('speechSynthesis' in window) {
      this.ttsUtterance = null;
      window.speechSynthesis.cancel();
    }
  }

  interrupt(): void {
    this.stopPlayback();
  }

  private detachMic(stopTracks: boolean): void {
    if (stopTracks) {
      for (const t of this.micStream?.getTracks() ?? []) t.stop();
    }
    try {
      this.micSource?.disconnect();
    } catch {
      /* noop */
    }
    this.micStream = null;
    this.micSource = null;
    this.micAnalyser = null;
  }

  destroy(): void {
    this.destroyed = true;
    this.stopPlayback();
    this.detachMic(true);
    if (this.ctx) void this.ctx.close().catch(noop);
    this.ctx = null;
  }
}

export const audioManager = new AudioManager();
