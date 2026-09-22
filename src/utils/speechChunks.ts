// Pure sentence splitter for streaming speech: returns newly completed
// sentence(s) beyond `spokenLen`, or null when nothing is speakable yet.
// Unit-tested.

export function nextSpeakable(
  full: string,
  spokenLen: number,
): { text: string; newLen: number } | null {
  const fresh = full.slice(spokenLen);
  const m = fresh.match(/^([\s\S]*?[.!?…]+)(\s|$)/);
  if (!m) return null;
  const text = m[1].trim();
  if (text.length < 2) return null;
  return { text, newLen: spokenLen + m[1].length };
}
