// SpeechToText — Web Speech API wrapper (live partials) with
// MediaRecorder fallback for backends that do server-side STT.

export interface SttCallbacks {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
}

type Recog = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function getRecognitionCtor(): (new () => Recog) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recog;
    webkitSpeechRecognition?: new () => Recog;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * TranscriptBuffer — accumulates final transcripts with an explicit consume
 * point, so continuous recognition can run across turns without restarts.
 * Pure logic, unit-tested.
 */
export class TranscriptBuffer {
  private finals: string[] = [];
  private consumed = 0;

  pushFinal(text: string): void {
    const t = text.trim();
    if (t) this.finals.push(t);
  }

  /** Everything finalized since the last consume(). */
  peek(): string {
    return this.finals.slice(this.consumed).join(' ').trim();
  }

  consume(): string {
    const out = this.peek();
    this.consumed = this.finals.length;
    return out;
  }

  reset(): void {
    this.finals = [];
    this.consumed = 0;
  }
}

export class SpeechToText {
  private recog: Recog | null = null;
  private listening = false;
  private wantStop = false;
  private buffer = new TranscriptBuffer();
  private chunks: Blob[] = [];
  private recorder: MediaRecorder | null = null;

  get supported(): boolean {
    return getRecognitionCtor() !== null;
  }

  get isListening(): boolean {
    return this.listening;
  }

  get lastTranscript(): string {
    return this.buffer.peek();
  }

  /** Finals since the last consume — the continuous-mode send primitive. */
  consumeFinals(): string {
    return this.buffer.consume();
  }

  peekFinals(): string {
    return this.buffer.peek();
  }

  start(cb: SttCallbacks, lang = 'en-US'): boolean {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      cb.onError?.('Speech recognition is not supported in this browser.');
      return false;
    }
    this.stop();
    this.wantStop = false;
    this.buffer.reset();
    const r = new Ctor();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = true;
    r.maxAlternatives = 1;
    r.onresult = (ev: unknown) => {
      const e = ev as {
        results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
        resultIndex: number;
      };
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          this.buffer.pushFinal(res[0].transcript);
          cb.onFinal?.(this.buffer.peek());
        } else {
          interim += res[0].transcript;
        }
      }
      if (interim) cb.onPartial?.(`${this.buffer.peek()} ${interim}`.trim());
    };
    r.onerror = (ev: unknown) => {
      const e = ev as { error?: string };
      if (e.error === 'aborted' || e.error === 'no-speech') return;
      cb.onError?.(e.error ?? 'stt-failure');
    };
    r.onend = () => {
      // Auto-restart while we still want to listen (continuous dictation).
      if (!this.wantStop && this.listening) {
        try {
          r.start();
          return;
        } catch {
          /* fall through */
        }
      }
      this.listening = false;
    };
    this.recog = r;
    try {
      r.start();
      this.listening = true;
      return true;
    } catch {
      cb.onError?.('Could not start speech recognition.');
      return false;
    }
  }

  stop(): string {
    this.wantStop = true;
    try {
      this.recog?.stop();
    } catch {
      /* noop */
    }
    this.listening = false;
    const out = this.buffer.consume();
    this.recog = null;
    return out;
  }

  abort(): void {
    this.wantStop = true;
    try {
      this.recog?.abort();
    } catch {
      /* noop */
    }
    this.recog = null;
    this.listening = false;
  }

  /** Record an utterance to a Blob for server-side STT / realtime audio.chunk. */
  startCapture(stream: MediaStream): void {
    this.chunks = [];
    try {
      this.recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : undefined,
      });
    } catch {
      return;
    }
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(250);
  }

  async stopCapture(): Promise<Blob | null> {
    const rec = this.recorder;
    if (!rec) return null;
    this.recorder = null;
    return new Promise((resolve) => {
      rec.onstop = () => {
        if (this.chunks.length === 0) return resolve(null);
        resolve(new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }));
      };
      try {
        rec.stop();
      } catch {
        resolve(null);
      }
      setTimeout(() => resolve(null), 1500);
    });
  }
}

export const speechToText = new SpeechToText();
