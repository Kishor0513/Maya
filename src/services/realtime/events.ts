import type { MayaState, RealtimeEvent, SourceRef } from '../../types';

// Normalize provider-specific wire messages into RealtimeEvent.
// Keeps the React app decoupled from any single realtime protocol.

export function normalizeWireMessage(raw: string | ArrayBuffer): RealtimeEvent | null {
  if (raw instanceof ArrayBuffer) {
    return { type: 'audio.chunk', data: raw };
  }
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const t = String(msg.type ?? '');

  switch (t) {
    case 'transcript.partial':
    case 'transcript.update':
      return { type: 'transcript.partial', text: String(msg.text ?? '') };
    case 'transcript.final':
    case 'transcript.done':
      return { type: 'transcript.final', text: String(msg.text ?? '') };
    case 'response.text':
    case 'response.delta':
    case 'text.delta':
      return { type: 'response.text', text: String(msg.text ?? msg.delta ?? '') };
    case 'response.done':
      return { type: 'response.text', text: '', done: true };
    case 'audio.chunk':
    case 'audio.delta': {
      const b64 = String(msg.data ?? msg.audio ?? '');
      if (!b64) return null;
      return { type: 'audio.chunk', data: b64ToBuffer(b64) };
    }
    case 'maya.state':
      return { type: 'maya.state', state: toMayaState(msg.state) };
    case 'sources':
      return { type: 'sources', sources: toSources(msg.sources) };
    case 'tool.activity':
      return {
        type: 'tool.activity',
        name: String(msg.name ?? 'tool'),
        summary: String(msg.summary ?? ''),
      };
    case 'error':
      return {
        type: 'error',
        message: String(msg.message ?? 'Realtime error'),
        code: typeof msg.code === 'string' ? msg.code : undefined,
      };
    case 'pong':
      return null;
    default:
      return null;
  }
}

function toMayaState(v: unknown): MayaState {
  const s = String(v ?? 'idle');
  const allowed: MayaState[] = [
    'idle',
    'listening',
    'processing',
    'speaking',
    'happy',
    'sad',
    'excited',
    'playful',
    'curious',
    'concerned',
  ];
  return (allowed.includes(s as MayaState) ? s : 'idle') as MayaState;
}

function toSources(v: unknown): SourceRef[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s) => ({
      title: String(s.title ?? 'Source'),
      url: typeof s.url === 'string' ? s.url : undefined,
    }));
}

function b64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? '');
      resolve(s.includes(',') ? s.split(',')[1] : s);
    };
    r.onerror = () => reject(new Error('blob-encode-failed'));
    r.readAsDataURL(blob);
  });
}
