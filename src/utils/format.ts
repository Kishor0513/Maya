export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function groupByDay(conversations: { createdAt: number }[]): string[] {
  void conversations;
  return ['Today', 'Yesterday', 'Older'];
}

export function supportsRequiredAPIs(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!navigator.mediaDevices?.getUserMedia) missing.push('Microphone (getUserMedia)');
  if (typeof window.AudioContext === 'undefined') missing.push('Web Audio');
  if (typeof window.WebSocket === 'undefined') missing.push('WebSocket');
  return { ok: missing.length === 0, missing };
}

export function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: number | undefined;
  return ((...args: never[]) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  }) as T;
}
