import type { ChatMessage, ConversationSummary } from '../../types';

// Conversation summarization — local rolling summary for context-window
// control. Backend should run the full LLM summarizer; this keeps the
// frontend contract identical (recent + summary + memories).

export function summarizeMessages(messages: ChatMessage[]): ConversationSummary {
  const substantive = messages.filter((m) => m.text.trim().length > 1).slice(-30);
  const topics = extractTopics(substantive.map((m) => m.text).join('\n'));
  const first = substantive[0]?.text.slice(0, 90) ?? '';
  const last = substantive[substantive.length - 1]?.text.slice(0, 90) ?? '';
  return {
    id: crypto.randomUUID(),
    date: new Date().toISOString(),
    summary:
      substantive.length === 0
        ? 'No conversation yet.'
        : `Conversation with ${substantive.length} turns. Started around "${first}…". Latest: "${last}…". Topics: ${topics.join(', ') || 'general chat'}.`,
    importantTopics: topics,
  };
}

function extractTopics(text: string): string[] {
  const STOP = new Set([
    'that', 'this', 'with', 'have', 'from', 'what', 'when', 'where', 'your',
    'about', 'there', 'they', 'them', 'then', 'than', 'know', 'like', 'just',
    'really', 'going', 'yeah', 'okay', 'well', 'much', 'more', 'some',
  ]);
  const freq = new Map<string, number>();
  // eslint-disable-next-line no-misleading-character-class -- Devanagari block intentionally includes combining marks
  for (const w of text.toLowerCase().replace(/[^a-z\u0900-\u097f\s]/giu, ' ').split(/\s+/)) {
    if (w.length > 3 && !STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);
}

export function autoTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.text.trim());
  if (!firstUser) return 'New conversation';
  const words = firstUser.text.trim().split(/\s+/).slice(0, 6).join(' ');
  return words.length > 42 ? words.slice(0, 42) + '…' : words;
}
