import { supabaseCloud, isCloudAuth } from './supabaseClient';

/** Fire-and-forget product analytics into Supabase. Never breaks the app. */
export function trackEvent(name: string, props: Record<string, unknown> = {}): void {
  if (!isCloudAuth()) return;
  void (async () => {
    try {
      const sb = await supabaseCloud();
      const user = (await sb?.auth.getUser())?.data.user;
      if (!sb || !user) return;
      await sb.from('events').insert({ owner: user.id, name, props, created: Date.now() });
    } catch {
      /* analytics must not break the app */
    }
  })();
}
