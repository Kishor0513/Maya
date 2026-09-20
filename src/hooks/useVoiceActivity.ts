import { useEffect, useRef } from 'react';
import { audioManager } from '../services/audio/AudioManager';
import { VoiceActivityDetector } from '../services/audio/vad';
import { useSettingsStore } from '../stores/settingsStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useMayaStore } from '../stores/mayaStore';

/**
 * Drives VAD from AudioManager levels. Level pump for avatar/waveform runs
 * here too (zustand set outside React render via rAF-throttled updates).
 */
export function useVoiceActivity(opts: {
  enabled: boolean;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
}) {
  const vadSensitivity = useSettingsStore((s) => s.audio.vadSensitivity);
  const silenceMs = useSettingsStore((s) => s.audio.silenceMs);
  const setVadSpeaking = useVoiceStore((s) => s.setVadSpeaking);
  const setLevels = useMayaStore((s) => s.setLevels);
  const ttsActive = useMayaStore((s) => s.ttsActive);
  const cbRef = useRef(opts);
  cbRef.current = opts;

  useEffect(() => {
    if (!opts.enabled) return;
    let raf = 0;
    let lastPush = 0;
    const vad = new VoiceActivityDetector(() => audioManager.getInputLevel(), {
      sensitivity: vadSensitivity,
      silenceMs,
      onSpeechStart: () => {
        setVadSpeaking(true);
        cbRef.current.onSpeechStart?.();
      },
      onSpeechEnd: () => {
        setVadSpeaking(false);
        cbRef.current.onSpeechEnd?.();
      },
    });
    vad.start();
    const pump = () => {
      const now = performance.now();
      if (now - lastPush > 66) {
        lastPush = now;
        const { input } = audioManager.getLevels();
        const output = ttsActive
          ? audioManager.ttsPseudoLevel(true, now)
          : audioManager.getOutputLevel();
        setLevels(input, output);
      }
      raf = requestAnimationFrame(pump);
    };
    raf = requestAnimationFrame(pump);
    return () => {
      vad.stop();
      cancelAnimationFrame(raf);
    };
  }, [opts.enabled, vadSensitivity, silenceMs, setVadSpeaking, setLevels, ttsActive]);
}
