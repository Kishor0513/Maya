import type { Conversation } from '../types';
import { formatTime } from './format';

/** Export a conversation as Markdown (download or share). Pure — tested. */
export function conversationToMarkdown(c: Conversation): string {
  const lines = [
    `# ${c.title}`,
    `Exported ${new Date().toLocaleString()} · ${c.messages.length} messages`,
    '',
  ];
  for (const m of c.messages) {
    const who = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Maya' : 'System';
    lines.push(`**${who}** (${formatTime(m.timestamp)}):`, '', m.text || '…', '');
    if (m.images && m.images.length > 0) lines.push(`[${m.images.length} image(s) attached]`, '');
  }
  return lines.join('\n');
}

export function downloadFile(name: string, text: string, mime = 'text/markdown'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFileName(title: string): string {
  return (
    title
      .toLowerCase()
      // eslint-disable-next-line no-misleading-character-class -- Devanagari block intentionally includes combining marks
      .replace(/[^a-z0-9\u0900-\u097f]+/giu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'conversation'
  );
}
