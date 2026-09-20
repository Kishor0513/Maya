import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AppSettings,
  Conversation,
  ChatMessage,
  MayaError,
  ConnectionStatus,
  ConversationState,
} from '../types';
import { transition } from '../features/conversation/machine';
import { autoTitle } from '../services/memory/summarizer';

interface ConversationStore {
  conversations: Conversation[];
  activeId: string | null;
  convState: ConversationState;
  connection: ConnectionStatus;
  partialUser: string;
  partialMaya: string;
  error: MayaError | null;
  setConnection: (c: ConnectionStatus) => void;
  setConvState: (s: ConversationState) => void;
  setPartialUser: (t: string) => void;
  setPartialMaya: (t: string) => void;
  setError: (e: MayaError | null) => void;
  newConversation: () => string;
  setActive: (id: string) => void;
  deleteConversation: (id: string) => void;
  clearAllConversations: () => void;
  appendMessage: (msg: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string }) => ChatMessage;
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
  activeConversation: () => Conversation | undefined;
}

function blankConversation(): Conversation {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: 'New conversation',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export const useConversationStore = create<ConversationStore>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeId: null,
      convState: 'disconnected',
      connection: 'offline',
      partialUser: '',
      partialMaya: '',
      error: null,

      setConnection: (connection) => set({ connection }),
      setConvState: (s) =>
        set((st) => ({ convState: transition(st.convState, s) })),
      setPartialUser: (partialUser) => set({ partialUser }),
      setPartialMaya: (partialMaya) => set({ partialMaya }),
      setError: (error) => set({ error }),

      newConversation: () => {
        const c = blankConversation();
        set((st) => ({ conversations: [c, ...st.conversations], activeId: c.id }));
        return c.id;
      },
      setActive: (activeId) => set({ activeId, partialUser: '', partialMaya: '' }),
      deleteConversation: (id) =>
        set((st) => {
          const conversations = st.conversations.filter((c) => c.id !== id);
          const activeId =
            st.activeId === id ? (conversations[0]?.id ?? null) : st.activeId;
          return { conversations, activeId };
        }),
      clearAllConversations: () => set({ conversations: [], activeId: null }),

      appendMessage: (msg) => {
        let id = get().activeId;
        if (!id) {
          const c = blankConversation();
          id = c.id;
          set((st) => ({ conversations: [c, ...st.conversations], activeId: id }));
        }
        const full: ChatMessage = {
          id: msg.id ?? crypto.randomUUID(),
          timestamp: Date.now(),
          ...msg,
          conversationId: id as string,
        };
        set((st) => ({
          conversations: st.conversations.map((c) =>
            c.id === id
              ? {
                  ...c,
                  updatedAt: Date.now(),
                  title:
                    c.title === 'New conversation'
                      ? autoTitle([...c.messages, full])
                      : c.title,
                  messages: [...c.messages, full],
                }
              : c,
          ),
        }));
        return full;
      },
      updateMessage: (id, patch) =>
        set((st) => ({
          conversations: st.conversations.map((c) => ({
            ...c,
            messages: c.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
          })),
        })),
      activeConversation: () =>
        get().conversations.find((c) => c.id === get().activeId),
    }),
    {
      name: 'maya.conversations.v1',
      partialize: (s) => ({
        conversations: s.conversations,
        activeId: s.activeId,
      }) as unknown as ConversationStore,
    },
  ),
);

export function useActiveMessages(): ChatMessage[] {
  return useConversationStore((s) => s.activeConversation()?.messages ?? []);
}

// Re-exported so settings persistence types stay local to stores.
export type { AppSettings };
