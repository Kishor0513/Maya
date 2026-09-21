import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../types';
import { formatTime } from '../../utils/format';

export function TranscriptMessage({ message }: { message: ChatMessage }) {
  const mine = message.role === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={
          mine
            ? 'max-w-[85%] rounded-2xl rounded-br-md bg-violet-300/[0.14] border border-violet-200/15 px-4 py-2.5'
            : 'max-w-[88%] px-1 py-1'
        }
      >
        <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500 mb-1">
          {mine ? 'You' : 'Maya'} · {formatTime(message.timestamp)}
        </p>
        <p className="text-[15px] leading-relaxed text-zinc-100 whitespace-pre-wrap">
          {message.text}
          {message.partial && <span className="ml-1 inline-block h-4 w-[2px] animate-pulse bg-violet-300 align-middle" />}
        </p>
        {message.images && message.images.length > 0 && (
          <div className="mb-1 mt-2 grid grid-cols-3 gap-1.5">
            {message.images.map((src, i) => (
              <img key={i} src={src} alt={`Attached image ${i + 1}`} loading="lazy" className="aspect-square rounded-lg border border-white/10 object-cover" />
            ))}
          </div>
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <p className="mt-1 text-[11px] text-zinc-500">used {message.toolCalls.map((t) => t.name).join(', ')}</p>
        )}
        {message.sources && message.sources.length > 0 && (
          <div className="mt-2 text-xs text-zinc-400">
            <p className="uppercase tracking-widest text-[10px] mb-1">Sources</p>
            <ul className="space-y-0.5">
              {message.sources.map((s, i) => (
                <li key={i}>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer" className="underline decoration-white/20 underline-offset-2 hover:text-white">
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
  );
}

export function ConversationTranscript({
  messages,
  partialUser,
  partialMaya,
  open,
}: {
  messages: ChatMessage[];
  partialUser: string;
  partialMaya: string;
  open: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, partialUser, partialMaya, open]);

  if (!open) return null;
  return (
    <section
      aria-label="Conversation transcript"
      className="w-full max-w-xl mx-auto rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-4 max-h-[38vh] overflow-y-auto shadow-soft"
    >
      {messages.length === 0 && !partialUser && !partialMaya ? (
        <p className="text-sm text-zinc-500 text-center py-6">
          Your conversations with Maya will appear here.
        </p>
      ) : (
        <div className="space-y-4">
          {messages.map((m) => (
            <TranscriptMessage key={m.id} message={m} />
          ))}
          {partialUser && (
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.06] border border-white/10 px-4 py-2.5">
                <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500 mb-1">You · speaking</p>
                <p className="text-[15px] text-zinc-300 italic">{partialUser}</p>
              </div>
            </div>
          )}
          {partialMaya && messages[messages.length - 1]?.partial !== true && (
            <div className="px-1">
              <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500 mb-1">Maya</p>
              <p className="text-[15px] text-zinc-100">{partialMaya}</p>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </section>
  );
}
