import { describe, it, expect } from 'vitest';
import { canTransition, transition } from '../features/conversation/machine';
import { nextEmotion, NEUTRAL_EMOTION, detectSignals } from '../features/personality/engine';
import { normalizeWireMessage } from '../services/realtime/events';
import { buildSystemPrompt } from '../services/ai/prompt';
import { summarizeMessages, autoTitle } from '../services/memory/summarizer';

describe('conversation state machine', () => {
  it('allows connected → listening → processing → speaking → listening', () => {
    expect(canTransition('connected', 'listening')).toBe(true);
    expect(canTransition('listening', 'processing')).toBe(true);
    expect(canTransition('processing', 'speaking')).toBe(true);
    expect(canTransition('speaking', 'listening')).toBe(true);
  });

  it('supports interruption: speaking → interrupted → listening', () => {
    expect(transition('speaking', 'interrupted')).toBe('interrupted');
    expect(transition('interrupted', 'listening')).toBe('listening');
  });

  it('rejects illegal jumps', () => {
    expect(transition('disconnected', 'speaking')).toBe('disconnected');
  });
});

describe('emotion engine', () => {
  it('drifts gradually, never jumps', () => {
    const next = nextEmotion(NEUTRAL_EMOTION, { userJoy: true });
    expect(next.excitement).toBeGreaterThan(NEUTRAL_EMOTION.excitement);
    expect(next.excitement - NEUTRAL_EMOTION.excitement).toBeLessThan(0.3);
  });

  it('detects sadness signals', () => {
    expect(detectSignals('I had a terrible day, feeling sad').userSad).toBe(true);
  });
});

describe('event normalization', () => {
  it('normalizes transcript + response + error frames', () => {
    expect(normalizeWireMessage(JSON.stringify({ type: 'transcript.partial', text: 'hel' })))
      .toEqual({ type: 'transcript.partial', text: 'hel' });
    expect(normalizeWireMessage(JSON.stringify({ type: 'response.done' })))
      .toEqual({ type: 'response.text', text: '', done: true });
    expect(normalizeWireMessage(JSON.stringify({ type: 'error', message: 'x' })))
      .toEqual({ type: 'error', message: 'x', code: undefined });
  });

  it('maps binary frames to audio.chunk', () => {
    const ev = normalizeWireMessage(new ArrayBuffer(8));
    expect(ev?.type).toBe('audio.chunk');
  });

  it('drops unknown / malformed frames', () => {
    expect(normalizeWireMessage('not-json')).toBeNull();
    expect(normalizeWireMessage(JSON.stringify({ type: 'pong' }))).toBeNull();
  });
});

describe('prompt + memory helpers', () => {
  it('builds a system prompt containing memories and language hint', () => {
    const prompt = buildSystemPrompt(undefined, {
      sessionId: 's',
      recentMessages: [],
      relevantMemories: [
        {
          id: '1', type: 'preference', key: 'favorite_editor', value: 'VS Code',
          confidence: 0.94, createdAt: 0, updatedAt: 0, lastAccessedAt: 0,
        },
      ],
      emotionalState: NEUTRAL_EMOTION,
      relationshipState: {
        familiarity: 0.2, trust: 0.2, conversationCount: 3,
        sharedTopics: ['code'], importantMoments: [],
      },
      language: 'auto',
    });
    expect(prompt).toContain('VS Code');
    expect(prompt).toContain('Match the user');
  });

  it('summarizes and titles conversations', () => {
    const now = Date.now();
    const msgs = [
      { id: 'a', conversationId: 'c', role: 'user' as const, text: 'I love working on my robot project', timestamp: now },
      { id: 'b', conversationId: 'c', role: 'assistant' as const, text: 'Tell me more', timestamp: now },
    ];
    expect(summarizeMessages(msgs).importantTopics.length).toBeGreaterThan(0);
    expect(autoTitle(msgs)).toContain('robot');
  });
});
