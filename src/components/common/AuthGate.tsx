import { useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { isCloudAuth } from '../../services/supabaseClient';

// Full-screen gate shown when the backend requires accounts and this
// browser has no session yet. Cloud mode signs in with email via Supabase.
export function AuthGate() {
  const cloud = isCloudAuth();
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setBad(false);
    const ok = await login(username.trim(), password);
    setBusy(false);
    if (!ok) setBad(true);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Sign in to Maya" className="fixed inset-0 z-50 grid place-items-center bg-[#050505]/95 backdrop-blur p-4">
      <form onSubmit={submit} className="w-full max-w-sm dialog-card p-6">
        <h1 className="font-display text-4xl italic text-white text-center">Maya</h1>
        <p className="mt-2 text-center text-sm text-zinc-500">
          This Maya server needs an account. Sign in to continue.
        </p>
        <label htmlFor="auth-user" className="mt-5 block text-xs uppercase tracking-widest text-zinc-500">
          {cloud ? 'Email' : 'Username'}
        </label>
        <input
          id="auth-user" value={username} autoFocus autoComplete={cloud ? 'email' : 'username'}
          onChange={(e) => setUsername(e.target.value)}
          className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-300/50"
        />
        <label htmlFor="auth-pass" className="mt-3 block text-xs uppercase tracking-widest text-zinc-500">
          Password
        </label>
        <input
          id="auth-pass" type="password" value={password} autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-300/50"
        />
        {bad && (
          <p role="alert" className="mt-3 text-sm text-rose-300">
            Wrong {cloud ? 'email' : 'username'} or password. Try again?
          </p>
        )}
        <button
          type="submit" disabled={busy}
          className="mt-5 w-full rounded-full bg-violet-300 py-2.5 text-sm font-medium text-black hover:bg-violet-200 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-200"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
