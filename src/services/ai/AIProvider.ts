import type {
  AIChunk,
  AIResponse,
  ChatMessage,
  ConversationContext,
} from '../../types';

/**
 * Provider abstraction. Frontend never holds provider secrets —
 * implementations must call the backend gateway (`/api/*`), never the
 * vendor API directly from the browser.
 */
export interface AIProvider {
  readonly id: string;
  readonly label: string;
  sendMessage(
    message: string,
    context: ConversationContext,
  ): AsyncIterable<AIChunk>;
  generateResponse(
    messages: ChatMessage[],
    context?: ConversationContext,
  ): Promise<AIResponse>;
}

export function chunk(text: string): AIChunk {
  return { text };
}

export function doneChunk(text = ''): AIChunk {
  return { text, done: true };
}

/** Split outgoing text into word-safe streaming chunks. */
export async function* streamWords(
  fullText: string,
  signal?: AbortSignal,
  wordsPerChunk = 3,
  delayMs = 24,
): AsyncIterable<AIChunk> {
  const words = fullText.split(/(\s+)/).filter((w) => w.length > 0);
  let buf = '';
  let count = 0;
  for (const w of words) {
    if (signal?.aborted) return;
    buf += w;
    if (!/^\s+$/.test(w)) count += 1;
    if (count >= wordsPerChunk) {
      yield chunk(buf);
      buf = '';
      count = 0;
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  yield doneChunk(buf);
}
