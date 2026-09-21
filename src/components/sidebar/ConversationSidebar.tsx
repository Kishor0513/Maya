import { useState } from 'react';
import { useConversationStore } from '../../stores/conversationStore';
import { timeAgo, cx } from '../../utils/format';
import { conversationToMarkdown, downloadFile, safeFileName } from '../../utils/export';

export function ConversationSidebar({
  open,
  onClose,
  onOpenSettings,
  onOpenMemory,
  onOpenDocs,
  onOpenPlans,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenMemory: () => void;
  onOpenDocs: () => void;
  onOpenPlans: () => void;
}) {
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const newConversation = useConversationStore((s) => s.newConversation);
  const setActive = useConversationStore((s) => s.setActive);
  const deleteConversation = useConversationStore((s) => s.deleteConversation);
  const [query, setQuery] = useState('');

  const filtered = conversations.filter((c) =>
    c.title.toLowerCase().includes(query.toLowerCase()) ||
    c.messages.some((m) => m.text.toLowerCase().includes(query.toLowerCase())),
  );

  const today: typeof filtered = [];
  const older: typeof filtered = [];
  const now = Date.now();
  for (const c of filtered) {
    (now - c.updatedAt < 86_400_000 ? today : older).push(c);
  }

  const exportConversation = (id: string) => {
    const c = conversations.find((x) => x.id === id);
    if (c) downloadFile(`${safeFileName(c.title)}.md`, conversationToMarkdown(c));
  };

  return (
    <>
      {/* Mobile scrim */}
      {open && (
        <button
          aria-label="Close sidebar"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
        />
      )}
      <aside
        aria-label="Conversations"
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-white/[0.07] bg-[#08080c]/95 backdrop-blur-xl transition-transform duration-300',
          'lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-4 pt-5">
          <p className="font-display text-2xl italic text-white">Maya</p>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-2 text-zinc-500 hover:text-white lg:hidden">✕</button>
        </div>

        <div className="px-4 pt-4">
          <button
            onClick={() => newConversation()}
            className="w-full rounded-full bg-white/[0.07] border border-white/10 py-2.5 text-sm text-white hover:bg-white/[0.11] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
          >
            + New conversation
          </button>
          <label className="sr-only" htmlFor="conv-search">Search conversations (Ctrl+K)</label>
          <input
            id="conv-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…  (Ctrl+K)"
            className="mt-3 w-full rounded-full bg-transparent border border-white/10 px-4 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-300/40"
          />
        </div>

        <nav className="mt-4 flex-1 overflow-y-auto px-2 pb-4" aria-label="Conversation history">
          {filtered.length === 0 && (
            <p className="px-4 pt-8 text-center text-sm text-zinc-600">
              Your conversations with Maya will appear here.
            </p>
          )}
          <Section title="Today" items={today} activeId={activeId} setActive={setActive} onDelete={deleteConversation} onExport={exportConversation} onNavigate={onClose} />
          <Section title="Older" items={older} activeId={activeId} setActive={setActive} onDelete={deleteConversation} onExport={exportConversation} onNavigate={onClose} />
        </nav>

        <div className="border-t border-white/[0.07] p-3 grid grid-cols-2 gap-2">
          <button onClick={onOpenMemory} className="rounded-full border border-white/10 py-2 text-xs text-zinc-300 hover:bg-white/5">Memory</button>
          <button onClick={onOpenDocs} className="rounded-full border border-white/10 py-2 text-xs text-zinc-300 hover:bg-white/5">Knowledge</button>
          <button onClick={onOpenPlans} className="rounded-full border border-white/10 py-2 text-xs text-zinc-300 hover:bg-white/5">Plans</button>
          <button onClick={onOpenSettings} className="rounded-full border border-white/10 py-2 text-xs text-zinc-300 hover:bg-white/5">Settings</button>
        </div>
      </aside>
    </>
  );
}

function Section({
  title,
  items,
  activeId,
  setActive,
  onDelete,
  onExport,
  onNavigate,
}: {
  title: string;
  items: ReturnType<typeof useConversationStore.getState>['conversations'];
  activeId: string | null;
  setActive: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onNavigate: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="px-3 pb-1 text-[10px] uppercase tracking-[0.18em] text-zinc-600">{title}</p>
      <ul className="space-y-0.5">
        {items.map((c) => (
          <li key={c.id} className="group relative">
            <button
              onClick={() => { setActive(c.id); onNavigate(); }}
              aria-current={c.id === activeId}
              className={cx(
                'w-full rounded-xl px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/60',
                c.id === activeId ? 'bg-violet-300/[0.12] text-white' : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200',
              )}
            >
              <span className="block truncate text-sm">{c.title}</span>
              <span className="block text-[11px] text-zinc-600">{timeAgo(c.updatedAt)}</span>
            </button>
            <button
              onClick={() => onExport(c.id)}
              aria-label={`Export ${c.title} as Markdown`}
              title="Export as Markdown"
              className="absolute right-9 top-2.5 hidden rounded-full px-2 py-0.5 text-xs text-zinc-600 hover:text-white group-hover:block"
            >
              ↓
            </button>
            <button
              onClick={() => onDelete(c.id)}
              aria-label={`Delete ${c.title}`}
              className="absolute right-2 top-2.5 hidden rounded-full px-2 py-0.5 text-xs text-zinc-600 hover:text-rose-300 group-hover:block"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
