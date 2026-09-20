import { useCallback, useEffect, useRef } from 'react';
import { audioManager } from '../services/audio/AudioManager';
import { useVoiceStore } from '../stores/voiceStore';

export function useMicrophone() {
  const { micPermission, setMicPermission, setMicActive } = useVoiceStore();
  const streamRef = useRef<MediaStream | null>(null);

  const ensure = useCallback(
    async (deviceId?: string): Promise<MediaStream | null> => {
      try {
        if (!audioManager.available) {
          setMicPermission('denied');
          return null;
        }
        const stream = await audioManager.requestMicrophone(deviceId);
        streamRef.current = stream;
        setMicPermission('granted');
        setMicActive(true);
        return stream;
      } catch (err) {
        const name = (err as DOMException)?.name;
        setMicPermission(name === 'NotAllowedError' ? 'denied' : 'prompt');
        setMicActive(false);
        return null;
      }
    },
    [setMicActive, setMicPermission],
  );

  useEffect(
    () => () => {
      // Do not stop tracks on unmount globally — AudioManager owns lifecycle.
    },
    [],
  );

  return { micPermission, ensure, stream: streamRef.current };
}
