import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ConversationState } from '../../types';
import { formatTime, cx } from '../../utils/format';
import { VoiceOrb } from '../avatar/VoiceOrb';

const SUGGESTIONS: { label: string; send: string }[] = [
  { label: 'Just say hi', send: 'Hey Maya!' },
  { label: 'Tell me a joke', send: 'Tell me a joke.' },
  { label: 'Check in with me', send: 'How are you doing today?' },
];

// Full chat thread — the text-first counterpart to the voice stage.
// Consumes the same message store + engine, so voice and typing interoperate.
export function ChatView({
  messages,
  partialUser,
  convState,
  onSuggestion,
}: {
  messages: ChatMessage[];
  partialUser: string;
  convState: ConversationState;
  onSuggestion: (text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);

  const signature = useMemo(
    () => messages.map((m) => `${m.id}:${m.text.length}${m.partial ? '*' : ''}`).join('|'),
    [messages],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stuck) el.scrollTop = el.scrollHeight;
  }, [signature, partialUser, stuck]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setStuck(true);
    }
  };

  const empty = messages.length === 0 && !partialUser;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        aria-label="Chat messages"
        aria-live="off"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-2xl space-y-4 px-1 py-5">
          {empty ? (
            <div className="py-10 text-center">
              <p className="font-display text-3xl italic text-zinc-100">Talk to Maya.</p>
              <p className="mt-2 text-sm text-zinc-500">
                Ask her something. Tell her something. Or just say hi.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => onSuggestion(s.send)}
                    className="rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-sm text-zinc-300 hover:bg-white/10 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) =>
              m.role === 'assistant' && m.partial && !m.text ? (
                <TypingBubble key={m.id} />
              ) : (
                <ChatBubble key={m.id} message={m} />
              ),
            )
          )}
          {partialUser && (
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md border border-white/10 bg-white/[0.06] px-4 py-2.5">
                <p className="text-[15px] italic text-zinc-300">“{partialUser}”</p>
                <p className="mt-1 text-right text-[10px] uppercase tracking-widest text-zinc-600">
                  speaking…
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      {!stuck && !empty && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label="Jump to latest messages"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-[#14141b]/95 px-4 py-1.5 text-xs text-zinc-300 shadow-soft backdrop-blur hover:text-white"
        >
          ↓ Latest
        </button>
      )}
      <span className="sr-only" aria-live="polite">
        {convState === 'processing' ? 'Maya is typing' : ''}
      </span>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const mine = message.role === 'user';
  if (mine) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-violet-200/15 bg-violet-300/[0.14] px-4 py-2.5">
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-100">
            {message.text}
          </p>
          <p className="mt-1 text-right text-[10px] text-zinc-500">
            {formatTime(message.timestamp)}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 shrink-0" aria-hidden>
        <VoiceOrb state={message.partial ? 'speaking' : 'idle'} level={message.partial ? 0.4 : 0.05} size={28} />
      </div>
      <div className="min-w-0 max-w-[88%]">
        <p className="mb-1 text-[11px] uppercase tracking-[0.14em] text-zinc-500">
          Maya · {formatTime(message.timestamp)}
        </p>
        <div className="rounded-2xl rounded-tl-md border border-white/[0.07] bg-white/[0.04] px-4 py-2.5">
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-100">
            {message.text}
            {message.partial && (
              <span className="ml-1 inline-block h-4 w-[2px] animate-pulse bg-violet-300 align-middle" aria-hidden />
            )}
          </p>
          {message.images && message.images.length > 0 && (
            <div className="mb-1 mt-2 grid grid-cols-3 gap-1.5">
              {message.images.map((src, i) => (
                <img key={i} src={src} alt={`Attached image ${i + 1}`} loading="lazy" className="aspect-square rounded-lg border border-white/10 object-cover" />
              ))}
            </div>
          )}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <p className="mt-1.5 text-[11px] text-zinc-500">
              used {message.toolCalls.map((t) => t.name).join(', ')}
            </p>
          )}
          {message.sources && message.sources.length > 0 && (
            <div className="mt-2 border-t border-white/[0.07] pt-2 text-xs text-zinc-400">
              <p className="mb-1 text-[10px] uppercase tracking-widest">Sources</p>
              <ul className="space-y-0.5">
                {message.sources.map((s, i) => (
                  <li key={i} className={cx(s.url && 'underline decoration-white/20 underline-offset-2')}>
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noreferrer" className="hover:text-white">
                        {s.title}
                      </a>
                    ) : (
                      s.title
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex items-start gap-2.5" aria-hidden>
      <div className="mt-0.5 shrink-0">
        <VoiceOrb state="processing" level={0.3} size={28} />
      </div>
      <div className="rounded-2xl rounded-tl-md border border-white/[0.07] bg-white/[0.04] px-5 py-3.5">
        <span className="flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400"
              style={{ animationDelay: `${i * 220}ms`, animationDuration: '1.1s' }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
