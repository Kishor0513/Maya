import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

interface AuthStore {
  token: string | null;
  user: string | null;
  /** Null = unknown yet; true = gateway demands login. */
  required: boolean | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  probe: () => Promise<void>;
}

/**
 * Gateway session. Empty token = open single-user gateway.
 * Cleared automatically on 401s (see the conversation engine).
 */
export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      required: null,
      login: async (username, password) => {
        try {
          const res = await fetch(`${API_BASE}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username, password }),
          });
          if (!res.ok) return false;
          const data = (await res.json()) as { token: string | null; user: string };
          set({ token: data.token, user: data.user });
          return true;
        } catch {
          return false;
        }
      },
      logout: () => set({ token: null, user: null }),
      probe: async () => {
        try {
          const res = await fetch(`${API_BASE}/api/health`);
          if (!res.ok) return;
          const data = (await res.json()) as { auth?: boolean };
          set({ required: !!data.auth });
        } catch {
          /* gateway unreachable — existing error flows handle it */
        }
      },
    }),
    { name: 'maya.auth.v1' },
  ),
);

/** Raw token for non-store contexts (fetch headers). */
export function authToken(): string | null {
  try {
    return useAuthStore.getState().token;
  } catch {
    return null;
  }
}
