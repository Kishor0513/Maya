import { useMemo, type ReactNode } from 'react';

// Tiny XSS-safe Markdown renderer for assistant messages: bold, italic,
// inline code, fenced code, links, lists, paragraphs. Built from React nodes
// (never dangerouslySetInnerHTML), forgiving of unclosed markers mid-stream.

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*.+?\*\*|\*[^*\n]+?\*|`[^`\n]+?`|\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  const pushText = (s: string) => {
    if (s) out.push(<span key={`${keyPrefix}-t${k++}`}>{s}</span>);
  };
  while ((m = re.exec(text)) !== null) {
    pushText(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-i${k++}`;
    if (token.startsWith('**')) {
      out.push(<strong key={key} className="font-semibold text-white">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('`')) {
      out.push(
        <code key={key} className="rounded bg-black/30 px-1 py-px text-[13px] text-violet-200">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      const label = token.slice(1, token.indexOf(']'));
      const href = token.slice(token.indexOf('(') + 1, -1);
      if (/^(https?:\/\/|mailto:)/i.test(href)) {
        out.push(
          <a key={key} href={href} target="_blank" rel="noreferrer" className="underline decoration-violet-300/50 underline-offset-2 hover:text-white">
            {label}
          </a>,
        );
      } else {
        pushText(token);
      }
    }
    last = m.index + token.length;
  }
  pushText(text.slice(last));
  return out;
}

function renderBlocks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Fenced code blocks first (may span lines).
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const firstNl = part.indexOf('\n');
      const code = (firstNl >= 0 ? part.slice(firstNl + 1) : part).replace(/\n$/, '');
      out.push(
        <pre key={`code-${i}`} className="my-2 overflow-x-auto rounded-xl border border-white/10 bg-black/40 p-3 text-[13px] leading-relaxed text-zinc-200">
          <code>{code}</code>
        </pre>,
      );
      return;
    }
    const lines = part.split('\n');
    let list: string[] | null = null;
    const flushList = (key: string) => {
      if (list) {
        out.push(
          <ul key={key} className="my-1.5 list-disc space-y-0.5 pl-5">
            {list.map((item, j) => (
              <li key={j}>{renderInline(item, `${key}-${j}`)}</li>
            ))}
          </ul>,
        );
        list = null;
      }
    };
    lines.forEach((line, j) => {
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        (list ??= []).push((bullet ?? numbered)![1]);
      } else {
        flushList(`l-${i}-${j}`);
        if (line.trim()) {
          out.push(
            <p key={`p-${i}-${j}`} className="my-1 first:mt-0 last:mb-0">
              {renderInline(line, `p-${i}-${j}`)}
            </p>,
          );
        }
      }
    });
    flushList(`l-${i}-end`);
  });
  return out;
}

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const nodes = useMemo(() => renderBlocks(text), [text]);
  return <div className={className}>{nodes}</div>;
}
