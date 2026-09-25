import { useRef, useState } from 'react';

/** Downscale an image client-side so multimodal sends stay small. */
function resizeImage(file: File, maxDim = 768, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no canvas');
        ctx.drawImage(img, 0, 0, w, h);
        const out = canvas.toDataURL('image/jpeg', quality);
        URL.revokeObjectURL(url);
        resolve(out);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e instanceof Error ? e : new Error('bad image'));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image.'));
    };
    img.src = url;
  });
}

export function ChatInput({
  onSend,
  disabled,
  placeholder = 'Type something…  (Enter to send)',
}: {
  onSend: (text: string, images: string[]) => boolean | Promise<boolean> | void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [attaching, setAttaching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = async () => {
    const t = value.trim();
    if ((!t && images.length === 0) || disabled) return;
    const accepted = await onSend(t, images);
    // false = engine busy — keep the text so nothing is silently lost.
    if (accepted === false) return;
    setValue('');
    setImages([]);
  };

  const attach = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAttaching(true);
    try {
      const next: string[] = [];
      for (const f of Array.from(files).slice(0, 3 - images.length)) {
        if (!f.type.startsWith('image/')) continue;
        next.push(await resizeImage(f));
      }
      setImages((prev) => [...prev, ...next].slice(0, 3));
    } finally {
      setAttaching(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="w-full max-w-xl mx-auto">
      <label htmlFor="maya-text" className="sr-only">
        Type to Maya
      </label>
      {images.length > 0 && (
        <div className="mb-2 flex gap-2">
          {images.map((src, i) => (
            <div key={i} className="relative">
              <img
                src={src}
                alt={`Attachment ${i + 1}`}
                className="h-16 w-16 rounded-xl border border-white/10 object-cover"
              />
              <button
                type="button"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                aria-label={`Remove attachment ${i + 1}`}
                className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-black/80 text-[10px] text-zinc-300 border border-white/20 hover:text-white"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[0.05] backdrop-blur-xl px-4 py-2.5 focus-within:border-violet-300/40 transition-colors">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          aria-label="Attach images"
          onChange={(e) => void attach(e.target.files)}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || attaching || images.length >= 3}
          aria-label="Attach an image"
          title="Attach images (multimodal models will see them)"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-zinc-400 hover:text-white hover:bg-white/5 disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
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
          disabled={disabled || (!value.trim() && images.length === 0)}
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
        Enter to send · Shift+Enter for newline · 📎 for images
      </p>
    </div>
  );
}
