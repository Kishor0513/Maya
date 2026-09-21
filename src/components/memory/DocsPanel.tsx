import { useEffect, useRef, useState } from 'react';
import { gatewayHeaders } from '../../services/gateway';

const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

interface DocItem {
  id: string;
  title: string;
  created: number;
  chunks: number;
}

// Knowledge panel — save text notes/documents for RAG retrieval.
// The gateway chunks + indexes them; matching passages are injected
// into the model's context automatically.
export function DocsPanel({ onClose }: { onClose: () => void }) {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/documents`, {
        headers: gatewayHeaders(),
        credentials: 'include',
      });
      if (res.ok) setDocs((await res.json()) as DocItem[]);
    } catch {
      /* offline — panel stays empty */
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/documents`, {
        method: 'POST',
        headers: gatewayHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'include',
        body: JSON.stringify({ title: title.trim(), text: body.slice(0, 20000) }),
      });
      if (res.ok) {
        setTitle('');
        setText('');
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`${API_BASE}/api/documents/${id}`, {
      method: 'DELETE',
      headers: gatewayHeaders(),
      credentials: 'include',
    }).catch(() => undefined);
    await refresh();
  };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '');
      setText((prev) => (prev ? `${prev}\n\n${content}` : content).slice(0, 20000));
      if (!title) setTitle(f.name.replace(/\.[^.]+$/, '').slice(0, 80));
    };
    reader.readAsText(f);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Knowledge" className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg max-h-[84vh] overflow-y-auto rounded-3xl border border-white/10 bg-[#0B0B0F] p-6 shadow-soft">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-3xl italic text-white">Knowledge</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Save notes Maya should consult. Matching passages reach her automatically.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close knowledge" className="rounded-full p-2 text-zinc-500 hover:text-white">✕</button>
        </div>

        <label htmlFor="doc-title" className="mt-4 block text-xs uppercase tracking-widest text-zinc-500">Title</label>
        <input
          id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="Robot project notes"
          className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-violet-300/50"
        />
        <label htmlFor="doc-text" className="mt-3 block text-xs uppercase tracking-widest text-zinc-500">Text</label>
        <textarea
          id="doc-text" rows={5} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Paste anything Maya should remember and reason over…"
          className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-violet-300/50"
        />
        <div className="mt-3 flex gap-2">
          <input
            ref={fileRef} type="file" accept=".txt,.md,.markdown,text/plain" className="hidden"
            aria-label="Upload a text file"
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <button
            type="button" onClick={() => fileRef.current?.click()}
            className="flex-1 rounded-full border border-white/10 py-2.5 text-sm text-zinc-300 hover:bg-white/5"
          >
            Upload .txt / .md
          </button>
          <button
            type="button" onClick={save} disabled={busy || !text.trim()}
            className="flex-1 rounded-full bg-violet-300 py-2.5 text-sm font-medium text-black hover:bg-violet-200 disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save to knowledge'}
          </button>
        </div>

        <h3 className="mt-6 mb-2 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          Saved ({docs.length})
        </h3>
        {docs.length === 0 ? (
          <p className="py-4 text-center text-sm text-zinc-600">
            Nothing saved yet. Try pasting project notes, then ask about them.
          </p>
        ) : (
          <ul className="space-y-2">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-zinc-100">{d.title}</p>
                  <p className="text-[11px] text-zinc-600">{d.chunks} passage{d.chunks === 1 ? '' : 's'} indexed</p>
                </div>
                <button onClick={() => remove(d.id)} className="shrink-0 rounded-full px-2.5 py-1 text-[11px] text-zinc-400 hover:text-rose-300 hover:bg-white/5">
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
