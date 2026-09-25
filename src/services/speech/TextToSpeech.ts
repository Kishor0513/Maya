import type { VoiceEmotion } from '../../types';
import { audioManager } from '../audio/AudioManager';

// TextToSpeech — browser speechSynthesis for demo/local voice today,
// with the interface ready for streaming provider audio (playChunk).

export interface SpeakOptions {
  rate?: number;
  pitch?: number;
  voiceId?: string;
  emotion?: VoiceEmotion;
  onEnd?: () => void;
  onStart?: () => void;
}

export class TextToSpeech {
  private speaking = false;

  get supported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  get isSpeaking(): boolean {
    return this.speaking || window.speechSynthesis?.speaking === true;
  }

  voices(): SpeechSynthesisVoice[] {
    if (!this.supported) return [];
    return window.speechSynthesis.getVoices();
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    const clean = text.trim();
    if (!clean) {
      opts.onEnd?.();
      return;
    }
    if (!this.supported) {
      opts.onEnd?.();
      return;
    }
    // Wait for voices on first call (Chrome loads async).
    if (window.speechSynthesis.getVoices().length === 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 800);
        window.speechSynthesis.onvoiceschanged = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
    this.speaking = true;
    opts.onStart?.();
    // Safety timeout: if the browser's speech engine wedges (no end event),
    // resolve anyway so conversation state can never lock up. Late end
    // events are ignored; interrupt() still stops any lingering audio.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.speaking = false;
        opts.onEnd?.();
        resolve();
      };
      const timer = setTimeout(finish, 60000);
      audioManager.speakWithSystemTTS(clean, {
        rate: opts.emotion ? opts.emotion.speed : (opts.rate ?? 1.02),
        pitch: opts.emotion ? opts.emotion.pitch : (opts.pitch ?? 1),
        voiceId: opts.voiceId,
        onEnd: finish,
      });
    });
  }

  /** Route a provider audio chunk to the output chain. */
  playChunk(data: ArrayBuffer): Promise<void> {
    return audioManager.playAudioChunk(data);
  }

  stop(): void {
    this.speaking = false;
    audioManager.stopPlayback();
  }
}

export const textToSpeech = new TextToSpeech();

/** Map Maya's emotional state to subtle TTS parameters. Never exaggerated. */
export function emotionToVoice(e: {
  excitement: number;
  mood: number;
  energy: number;
  concern: number;
}): VoiceEmotion {
  const speed =
    1 + e.excitement * 0.12 + e.energy * 0.06 - e.concern * 0.1 - (e.mood < 0 ? 0.06 : 0);
  const pitch = 1 + e.excitement * 0.08 - e.concern * 0.06;
  return {
    speed: clamp(speed, 0.85, 1.2),
    pitch: clamp(pitch, 0.9, 1.15),
    stability: 0.7,
    expressiveness: clamp(0.5 + e.excitement * 0.3 + e.energy * 0.2, 0, 1),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
