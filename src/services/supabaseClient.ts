// Supabase client for the browser. Only active when the Vercel-style cloud
// env is baked in (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY). Local dev
// without them keeps the legacy gateway-token flow untouched.
import type { SupabaseClient } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export function isCloudAuth(): boolean {
  return !!URL && !!ANON;
}

let client: SupabaseClient | null = null;

export async function supabaseCloud(): Promise<SupabaseClient | null> {
  if (!isCloudAuth()) return null;
  if (!client) {
    const { createClient } = await import('@supabase/supabase-js');
    client = createClient(URL as string, ANON as string, {
      auth: { persistSession: true, storageKey: 'maya-sb-auth' },
    });
  }
  return client;
}
