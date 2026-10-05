import { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { isCloudAuth, supabaseCloud } from '../../services/supabaseClient';

// Full-screen gate: cloud email auth (Supabase) or legacy gateway login.
// Handles Google OAuth return, forgot-password email, and the reset form.
export function AuthGate() {
  const cloud = isCloudAuth();
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [bad, setBad] = useState(false);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [newPass, setNewPass] = useState('');
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.location.hash.includes('type=recovery')) {
        setRecovery(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setBad(false);
    const ok = await login(username.trim(), password);
    setBusy(false);
    if (!ok) setBad(true);
  };

  const google = async () => {
    if (busy) return;
    setBusy(true);
    setBad(false);
    try {
      const sb = await supabaseCloud();
      if (!sb) throw new Error('no supabase');
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      });
      if (error) setBad(true);
    } catch {
      setBad(true);
    } finally {
      setBusy(false);
    }
  };

  const sendReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || busy) return;
    setBusy(true);
    try {
      const sb = await supabaseCloud();
      if (!sb) throw new Error('no supabase');
      const { error } = await sb.auth.resetPasswordForEmail(username.trim(), {
        redirectTo: `${window.location.origin}/?view=account-recovery`,
      });
      if (error) setBad(true);
      else setForgotSent(true);
    } catch {
      setBad(true);
    } finally {
      setBusy(false);
    }
  };

  const saveNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPass.length < 8 || busy) return;
    setBusy(true);
    setBad(false);
    try {
      const sb = await supabaseCloud();
      if (!sb) throw new Error('no supabase');
      const { error } = await sb.auth.updateUser({ password: newPass });
      if (error) setBad(true);
      else {
        setResetDone(true);
        try {
          window.history.replaceState(null, '', window.location.pathname);
        } catch {
          /* ignore */
        }
      }
    } catch {
      setBad(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Sign in to Maya" className="fixed inset-0 z-50 grid place-items-center bg-[#050505]/95 backdrop-blur p-4">
      <div className="w-full max-w-sm dialog-card p-6">
        <h1 className="font-display text-4xl italic text-white text-center">Maya</h1>

        {recovery ? (
          <form onSubmit={saveNewPassword}>
            <p className="mt-2 text-center text-sm text-zinc-500">
              {resetDone ? 'Password updated — you are signed in.' : 'Choose a new password.'}
            </p>
            {!resetDone && (
              <>
                <label htmlFor="auth-new" className="mt-5 block text-xs uppercase tracking-widest text-zinc-500">
                  New password (8+ characters)
                </label>
                <input
                  id="auth-new" type="password" value={newPass} autoFocus autoComplete="new-password"
                  onChange={(e) => setNewPass(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-300/50"
                />
                {bad && (
                  <p role="alert" className="mt-3 text-sm text-rose-300">
                    Could not update — the link may have expired. Request a fresh one.
                  </p>
                )}
                <button
                  type="submit" disabled={busy || newPass.length < 8}
                  className="mt-5 w-full rounded-full bg-violet-300 py-2.5 text-sm font-medium text-black hover:bg-violet-200 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-200"
                >
                  {busy ? 'Saving…' : 'Save new password'}
                </button>
              </>
            )}
          </form>
        ) : forgot ? (
          <form onSubmit={sendReset}>
            <p className="mt-2 text-center text-sm text-zinc-500">
              {forgotSent ? 'Check your inbox for the reset link.' : 'Enter your account email.'}
            </p>
            {!forgotSent && (
              <>
                <label htmlFor="auth-email" className="mt-5 block text-xs uppercase tracking-widest text-zinc-500">
                  Email
                </label>
                <input
                  id="auth-email" value={username} autoFocus autoComplete="email"
                  onChange={(e) => setUsername(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white focus:outline-none focus:border-violet-300/50"
                />
                {bad && (
                  <p role="alert" className="mt-3 text-sm text-rose-300">
                    Could not send. Check the address?
                  </p>
                )}
                <button
                  type="submit" disabled={busy}
                  className="mt-5 w-full rounded-full bg-violet-300 py-2.5 text-sm font-medium text-black hover:bg-violet-200 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-200"
                >
                  {busy ? 'Sending…' : 'Send reset link'}
                </button>
              </>
            )}
            <button
              type="button" onClick={() => { setForgot(false); setBad(false); }}
              className="mt-3 w-full text-center text-xs text-zinc-500 hover:text-white"
            >
              Back to sign in
            </button>
          </form>
        ) : (
          <form onSubmit={submit}>
            <p className="mt-2 text-center text-sm text-zinc-500">
              This Maya server needs an account. Sign in to continue.
            </p>
            {cloud && (
              <button
                type="button" onClick={google} disabled={busy}
                className="mt-4 w-full rounded-full border border-white/15 bg-white/[0.06] py-2.5 text-sm text-white hover:bg-white/10 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-200"
              >
                Continue with Google
              </button>
            )}
            {cloud && (
              <div className="my-3 flex items-center gap-3 text-[11px] uppercase tracking-widest text-zinc-600">
                <span className="h-px flex-1 bg-white/10" /> or <span className="h-px flex-1 bg-white/10" />
              </div>
            )}
            <label htmlFor="auth-user" className="mt-1 block text-xs uppercase tracking-widest text-zinc-500">
              {cloud ? 'Email' : 'Username'}
            </label>
            <input
              id="auth-user" value={username} autoFocus={!cloud} autoComplete={cloud ? 'email' : 'username'}
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
            {cloud && (
              <button
                type="button" onClick={() => { setForgot(true); setBad(false); }}
                className="mt-3 w-full text-center text-xs text-zinc-500 hover:text-white"
              >
                Forgot password?
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
