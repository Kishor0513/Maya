import type {
  AIChunk,
  AIResponse,
  ChatMessage,
  ConversationContext,
} from '../../types';
import type { AIProvider } from './AIProvider';
import { buildSystemPrompt } from './prompt';
import { gatewayHeaders } from '../gateway';

const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

interface ChatWireResponse {
  text: string;
}

/**
 * Backend-proxied OpenAI-compatible provider.
 * Browser → backend gateway → vendor. No secrets in the frontend.
 * Supports SSE streaming (`POST {endpoint}/chat/stream`) with graceful
 * fallback to unary (`POST {endpoint}/chat`).
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly id = 'openai-compatible';
  readonly label = 'Backend · OpenAI-compatible';
  private signal?: AbortSignal;

  constructor(
    private opts: { endpoint: string; model: string } = {
      endpoint: `${API_BASE}/api`,
      model: 'gpt-4o-mini',
    },
  ) {}

  withSignal(signal: AbortSignal): this {
    this.signal = signal;
    return this;
  }

  async *sendMessage(
    message: string,
    context: ConversationContext,
  ): AsyncIterable<AIChunk> {
    const system = buildSystemPrompt(undefined, context);
    const messages: ChatMessage[] = [
      ...context.recentMessages.slice(-12),
      {
        id: crypto.randomUUID(),
        conversationId: context.sessionId,
        role: 'user',
        text: message,
        timestamp: Date.now(),
      },
    ];
    yield* this.streamChat(messages, system, context);
  }

  async generateResponse(
    messages: ChatMessage[],
    context?: ConversationContext,
  ): Promise<AIResponse> {
    const endpoint = this.base() + '/chat';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: gatewayHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'include',
      signal: this.signal,
      body: JSON.stringify({
        model: this.opts.model,
        messages: this.toWire(messages, context),
      }),
    });
    if (!res.ok) throw this.httpError(res.status);
    const data = (await res.json()) as ChatWireResponse;
    return { text: data.text ?? '' };
  }

  private async *streamChat(
    messages: ChatMessage[],
    system: string,
    context: ConversationContext,
  ): AsyncIterable<AIChunk> {
    const endpoint = this.base() + '/chat/stream';
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: gatewayHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
        credentials: 'include',
        signal: this.signal,
        body: JSON.stringify({
          model: this.opts.model,
          messages: this.toWire(messages, context),
          system,
          sessionId: context.sessionId,
          language: context.language,
        }),
      });
    } catch {
      // Network down → fall back to unary once, then surface error.
      const one = await this.generateResponse(messages, context);
      yield { text: one.text, done: true };
      return;
    }
    if (!res.ok || !res.body) {
      if (res.status === 401 || res.status === 403) throw this.httpError(res.status);
      const one = await this.generateResponse(messages, context);
      yield { text: one.text, done: true };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          yield { text: '', done: true };
          return;
        }
        try {
          const json = JSON.parse(payload) as { delta?: string; text?: string };
          const t = json.delta ?? json.text ?? '';
          if (t) yield { text: t };
        } catch {
          /* keep-alive comment, ignore */
        }
      }
      if (this.signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
    yield { text: '', done: true };
  }

  private toWire(messages: ChatMessage[], context?: ConversationContext) {
    const out: { role: string; content: string }[] = [];
    if (context) out.push({ role: 'system', content: buildSystemPrompt(undefined, context) });
    for (const m of messages.slice(-20)) {
      if (m.role === 'system') continue;
      out.push({ role: m.role, content: m.text });
    }
    return out;
  }

  private base(): string {
    return (this.opts.endpoint || `${API_BASE}/api`).replace(/\/$/, '');
  }

  private httpError(status: number): Error {
    if (status === 401 || status === 403)
      return new Error('Invalid or missing credentials on the backend gateway.');
    if (status === 429) return new Error('Rate limited. Please wait a moment and try again.');
    if (status >= 500) return new Error('Backend unavailable. Please try again shortly.');
    return new Error(`Chat request failed (${status}).`);
  }
}
