// Maya cron worker: fires due reminders via Web Push.
// Trigger: pg_cron every minute → POST with the service-role key.
//   select cron.schedule('maya-reminders', '* * * * *', $$
//     select net.http_post(
//       url := 'https://<REF>.supabase.co/functions/v1/cron-reminders',
//       headers := '{"Content-Type":"application/json","Authorization":"Bearer <SERVICE_KEY>"}'::jsonb,
//       body := '{}'::jsonb); $$);
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_JWK ({"kty":"EC",...}), VAPID_SUBJECT.
// Uses the battle-tested web-push library (npm:) — no hand-rolled crypto.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

function cors(req: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': req.headers.get('origin') || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const H = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: H });
  }

  const now = Date.now();
  const { data: due } = await admin
    .from('reminders')
    .select('id,owner,text')
    .eq('delivered', false)
    .lte('at', now)
    .limit(25);

  if (!due || due.length === 0) {
    return new Response(JSON.stringify({ fired: 0 }), {
      headers: { ...H, 'Content-Type': 'application/json' },
    });
  }

  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_JWK') ?? '';
  const subject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:maya@localhost';
  let webpushOk = false;
  if (vapidPublic && vapidPrivate) {
    try {
      const privateJwk = JSON.parse(vapidPrivate) as { d?: string };
      if (privateJwk.d) {
        // web-push wants the raw base64url private key, not the JWK envelope.
        webpush.setVapidDetails(subject, vapidPublic, privateJwk.d);
        webpushOk = true;
      }
    } catch {
      webpushOk = false;
    }
  }

  let fired = 0;
  for (const r of due) {
    const { data: subs } = await admin
      .from('push_subscriptions')
      .select('endpoint,keys')
      .eq('owner', r.owner as string);
    if (webpushOk) {
      for (const s of subs ?? []) {
        try {
          await webpush.sendNotification(
            {
              endpoint: s.endpoint as string,
              keys: s.keys as { p256dh: string; auth: string },
            },
            JSON.stringify({ title: 'Maya reminder', body: String(r.text ?? '') }),
            { TTL: 3600 },
          );
        } catch {
          /* one bad subscription must not block the rest */
        }
      }
    }
    await admin.from('reminders').update({ delivered: true }).eq('id', r.id as string);
    fired++;
  }

  return new Response(JSON.stringify({ fired, push: webpushOk }), {
    headers: { ...H, 'Content-Type': 'application/json' },
  });
});
