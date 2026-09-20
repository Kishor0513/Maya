import { useState } from 'react';

export function ChatInput({
  onSend,
  disabled,
  placeholder = 'Type something…  (Enter to send)',
}: {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState('');

  const send = () => {
    const t = value.trim();
    if (!t || disabled) return;
    onSend(t);
    setValue('');
  };

  return (
    <div className="w-full max-w-xl mx-auto">
      <label htmlFor="maya-text" className="sr-only">
        Type to Maya
      </label>
      <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[0.05] backdrop-blur-xl px-4 py-2.5 focus-within:border-violet-300/40 transition-colors">
        <textarea
          id="maya-text"
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={placeholder}
          className="flex-1 resize-none bg-transparent text-[15px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none max-h-28"
        />
        <button
          type="button"
          onClick={send}
          disabled={disabled || !value.trim()}
          aria-label="Send message"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-violet-300/90 text-black disabled:opacity-30 hover:bg-violet-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-200"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
        </button>
      </div>
      <p className="mt-2 text-center text-[11px] text-zinc-600">
        Enter to send · Shift+Enter for newline
      </p>
    </div>
  );
}
