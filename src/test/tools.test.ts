import { describe, it, expect } from 'vitest';
import { TranscriptBuffer } from '../services/speech/SpeechToText';
import { parseWhen, describeWhen } from '../services/tools/MayaTools';
import { termVector, MemoryService } from '../services/memory/MemoryService';
import { conversationToMarkdown, safeFileName } from '../utils/export';

describe('TranscriptBuffer (continuous STT)', () => {
  it('accumulates finals and consumes exactly once', () => {
    const b = new TranscriptBuffer();
    expect(b.peek()).toBe('');
    b.pushFinal('hello world');
    b.pushFinal('  ');
    b.pushFinal('how are you');
    expect(b.peek()).toBe('hello world how are you');
    expect(b.consume()).toBe('hello world how are you');
    expect(b.peek()).toBe('');
    expect(b.consume()).toBe('');
  });

  it('only returns post-consume finals on the next peek', () => {
    const b = new TranscriptBuffer();
    b.pushFinal('first');
    b.consume();
    b.pushFinal('second');
    expect(b.peek()).toBe('second');
    b.reset();
    expect(b.peek()).toBe('');
  });
});

describe('parseWhen (reminder/event times)', () => {
  const FROM = new Date('2026-09-20T10:00:00').getTime();

  it('parses relative durations', () => {
    expect(parseWhen('in 10 minutes', FROM)).toBe(FROM + 600000);
    expect(parseWhen('in 2 hours', FROM)).toBe(FROM + 7200000);
    expect(parseWhen('in 30 seconds', FROM)).toBe(FROM + 30000);
  });

  it('parses clock times, rolling to the next occurrence', () => {
    const at = parseWhen('at 18:30', FROM) ?? 0;
    const d = new Date(at);
    expect(d.getHours()).toBe(18);
    expect(d.getMinutes()).toBe(30);
    expect(at).toBeGreaterThan(FROM);
  });

  it('rejects garbage', () => {
    expect(parseWhen('', FROM)).toBeNull();
    expect(parseWhen('sometime eventually', FROM)).toBeNull();
    expect(parseWhen('in 0 minutes', FROM)).toBeNull();
  });

  it('describes countdowns humanely', () => {
    expect(describeWhen(Date.now() + 600000)).toContain('10 minute');
  });
});

describe('termVector + TF-IDF retrieve', () => {
  it('counts content words, dropping stop words', () => {
    const v = termVector('the robot and the battery');
    expect(v.get('the')).toBeUndefined();
    expect(v.get('robot')).toBe(1);
  });

  it('ranks the semantically closest memory first', () => {
    const svc = new MemoryService();
    svc.upsert({ type: 'project', key: 'robot', value: 'robot battery lasts four hours', confidence: 0.8 });
    svc.upsert({ type: 'interest', key: 'cooking', value: 'pasta with tomato sauce recipe', confidence: 0.8 });
    const out = svc.retrieve('how long does the robot battery last', 2);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].key).toBe('robot');
  });
});

describe('conversation export', () => {
  it('renders markdown with speakers and timestamps', () => {
    const md = conversationToMarkdown({
      id: 'c',
      title: 'Test chat',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { id: 'a', conversationId: 'c', role: 'user', text: 'Hi', timestamp: 0 },
        { id: 'b', conversationId: 'c', role: 'assistant', text: 'Hey', timestamp: 0 },
      ],
    });
    expect(md).toContain('# Test chat');
    expect(md).toContain('**You**');
    expect(md).toContain('**Maya**');
  });

  it('builds safe file names', () => {
    expect(safeFileName('Hello World!')).toBe('hello-world');
    expect(safeFileName('')).toBe('conversation');
  });
});
