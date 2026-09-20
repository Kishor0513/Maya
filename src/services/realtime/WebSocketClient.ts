// WebSocketClient — reconnecting WS with heartbeat, auth, and backoff.

export interface WsCallbacks {
  onOpen?: () => void;
  onClose?: (clean: boolean) => void;
  onMessage?: (data: string | ArrayBuffer) => void;
  onError?: (message: string) => void;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private token: string | null = null;
  private manualClose = false;
  private retries = 0;
  private maxRetries = 8;
  private heartbeat: number | null = null;
  private reconnectTimer: number | null = null;
  private cb: WsCallbacks = {};

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(url: string, cb: WsCallbacks = {}, token?: string): void {
    this.url = url;
    this.cb = cb;
    this.token = token ?? null;
    this.manualClose = false;
    this.retries = 0;
    this.open();
  }

  private open(): void {
    if (!this.url) return;
    try {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        this.retries = 0;
        this.cb.onOpen?.();
        // Auth first (server validates session; never trust client claims).
        try {
          ws.send(
            JSON.stringify({
              type: 'session.start',
              sessionId: crypto.randomUUID(),
              token: this.token,
            }),
          );
        } catch {
          /* ignore */
        }
        this.startHeartbeat();
      };
      ws.onmessage = (ev) => this.cb.onMessage?.(ev.data as string | ArrayBuffer);
      ws.onerror = () => this.cb.onError?.('WebSocket error');
      ws.onclose = (ev) => {
        this.stopHeartbeat();
        this.cb.onClose?.(ev.wasClean);
        if (!this.manualClose) this.scheduleReconnect();
      };
    } catch {
      this.cb.onError?.('Could not open WebSocket');
      this.scheduleReconnect();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'ping', at: Date.now() }));
        } catch {
          /* ignore */
        }
      }
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.retries >= this.maxRetries) return;
    const delay = Math.min(15000, 800 * 2 ** this.retries) + Math.random() * 400;
    this.retries += 1;
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  send(obj: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  sendBytes(buf: ArrayBuffer): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(buf);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    try {
      this.ws?.close(1000, 'client-close');
    } catch {
      /* noop */
    }
    this.ws = null;
  }
}
