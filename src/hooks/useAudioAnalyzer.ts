import { useEffect } from 'react';
import { useMayaStore } from '../stores/mayaStore';
import { audioManager } from '../services/audio/AudioManager';

/** Poll AudioManager levels into the avatar store (throttled, no per-sample renders). */
export function useAudioAnalyzer(active: boolean) {
  const setLevels = useMayaStore((s) => s.setLevels);
  const ttsActive = useMayaStore((s) => s.ttsActive);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = 0;
    const loop = () => {
      const now = performance.now();
      if (now - last > 70) {
        last = now;
        const { input } = audioManager.getLevels();
        const output = ttsActive
          ? audioManager.ttsPseudoLevel(true, now)
          : audioManager.getOutputLevel();
        setLevels(input, output);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, setLevels, ttsActive]);
}
