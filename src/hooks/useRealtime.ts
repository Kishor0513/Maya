import { useEffect, useRef } from 'react';
import { realtimeConnection } from '../services/realtime/RealtimeConnection';
import { useConversationStore } from '../stores/conversationStore';

/**
 * Owns the realtime transport lifecycle.
 * Live WebSocket when VITE_REALTIME_URL is set, otherwise the local
 * loopback transport (browser STT + gateway chat). The brain is Gemini.
 */
export function useRealtime() {
  const setConnection = useConversationStore((s) => s.setConnection);
  const onEventRef = useRef<((ev: unknown) => void) | null>(null);

  useEffect(() => {
    const url = import.meta.env.VITE_REALTIME_URL as string | undefined;
    const mode = url ? ('websocket' as const) : ('demo' as const);
    realtimeConnection.connect(mode, url, {
      onStatus: (s) => setConnection(s),
      onEvent: (ev) => onEventRef.current?.(ev),
    });
    if (!url) setConnection('connected');
    return () => realtimeConnection.disconnect();
  }, [setConnection]);

  return { connection: realtimeConnection, subscribe: onEventRef };
}
