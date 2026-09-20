// Shared-secret header for the gateway (see server/hf-gateway.js).
// Baked in at build time via VITE_GATEWAY_TOKEN. Omit it and no header
// is sent (local dev stays exactly as before).
const TOKEN = import.meta.env.VITE_GATEWAY_TOKEN as string | undefined;

export function gatewayHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...(TOKEN ? { 'x-gateway-token': TOKEN } : {}), ...extra };
}

const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

/**
 * Resolve the chat backend base URL. An empty endpoint means "same setup as
 * the page": relative /api in local dev (Vite proxy or gateway-served dist),
 * or the baked VITE_API_URL for split hosting (Vercel frontend + gateway).
 */
export function resolveChatBase(endpoint: string): string {
  const e = endpoint.trim().replace(/\/$/, '');
  if (e) return e;
  return `${API_BASE}/api`;
}
