import type { ConnectionStatus, RealtimeEvent } from '../../types';
import { WebSocketClient } from './WebSocketClient';
import { normalizeWireMessage, blobToBase64 } from './events';

export interface RealtimeCallbacks {
  onEvent?: (ev: RealtimeEvent) => void;
  onStatus?: (s: ConnectionStatus) => void;
}

// RealtimeConnection — demo (local loopback) + WebSocket modes behind one API.
// Frontend consumes only normalized RealtimeEvent.

export type RealtimeMode = 'demo' | 'websocket';

export class RealtimeConnection {
  private ws = new WebSocketClient();
  private mode: RealtimeMode = 'demo';
  private status: ConnectionStatus = 'offline';
  private cb: RealtimeCallbacks = {};
  private sessionId = crypto.randomUUID();

  get currentStatus(): ConnectionStatus {
    return this.status;
  }

  get currentMode(): RealtimeMode {
    return this.mode;
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  connect(mode: RealtimeMode, url?: string, cb: RealtimeCallbacks = {}): void {
    this.cb = cb;
    this.mode = mode;
    this.sessionId = crypto.randomUUID();
    if (mode === 'demo') {
      this.setStatus('connected');
      // Demo emits a state event so avatar lights up immediately.
      queueMicrotask(() =>
        this.cb.onEvent?.({ type: 'maya.state', state: 'idle' }),
      );
      return;
    }
    if (!url) {
      this.cb.onEvent?.({ type: 'error', message: 'Missing realtime URL' });
      this.setStatus('error');
      return;
    }
    this.setStatus('connecting');
    this.ws.connect(
      url,
      {
        onOpen: () => this.setStatus('connected'),
        onClose: (clean) => {
          if (!clean) this.setStatus('reconnecting');
          else this.setStatus('offline');
        },
        onMessage: (data) => {
          const ev = normalizeWireMessage(data);
          if (ev) this.cb.onEvent?.(ev);
        },
        onError: (m) => this.cb.onEvent?.({ type: 'error', message: m }),
      },
    );
  }

  private setStatus(s: ConnectionStatus): void {
    this.status = s;
    this.cb.onStatus?.(s);
  }

  async sendAudio(blob: Blob): Promise<void> {
    if (this.mode === 'demo') return; // demo STT happens locally
    const b64 = await blobToBase64(blob).catch(() => null);
    if (!b64) return;
    this.ws.send({ type: 'audio.chunk', sessionId: this.sessionId, data: b64 });
  }

  sendText(text: string): void {
    if (this.mode === 'demo') return;
    this.ws.send({ type: 'message.text', sessionId: this.sessionId, text });
  }

  interrupt(): void {
    if (this.mode === 'demo') return;
    this.ws.send({ type: 'interrupt', sessionId: this.sessionId });
  }

  disconnect(): void {
    this.ws.close();
    this.setStatus('offline');
  }
}

export const realtimeConnection = new RealtimeConnection();
