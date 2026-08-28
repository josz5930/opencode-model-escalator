import { describe, it, expect } from 'vitest';
import { getLastUserPayload, type SessionMessage } from '../src/replay.js';

const userMsg = (
  id: string,
  parts: unknown[],
  agent?: string,
): SessionMessage => ({
  info: { id, role: 'user', ...(agent ? { agent } : {}) },
  parts,
});

const assistantMsg = (id: string): SessionMessage => ({
  info: { id, role: 'assistant' },
  parts: [{ type: 'text', text: 'ok' }],
});

describe('getLastUserPayload — FR-5 replay payload extraction', () => {
  it('returns the LAST user message parts + id, skipping later assistant turns', () => {
    const messages: SessionMessage[] = [
      userMsg('u1', [{ type: 'text', text: 'first' }]),
      assistantMsg('a1'),
      userMsg('u2', [{ type: 'text', text: 'second' }]),
      assistantMsg('a2'),
    ];
    const payload = getLastUserPayload(messages);
    expect(payload).not.toBeNull();
    expect(payload!.messageID).toBe('u2');
    expect(payload!.parts).toEqual([{ type: 'text', text: 'second' }]);
    expect(payload!.agent).toBeUndefined();
  });

  it('preserves the agent when the user message carries one', () => {
    const payload = getLastUserPayload([
      userMsg('u1', [{ type: 'text', text: 'hi' }], 'build'),
    ]);
    expect(payload!.agent).toBe('build');
  });

  it('returns null for empty / null / undefined / non-array input', () => {
    expect(getLastUserPayload([])).toBeNull();
    expect(getLastUserPayload(null)).toBeNull();
    expect(getLastUserPayload(undefined)).toBeNull();
    // deliberately malformed input
    expect(getLastUserPayload('nope' as unknown as SessionMessage[])).toBeNull();
  });

  it('returns null when there is no user message', () => {
    expect(getLastUserPayload([assistantMsg('a1'), assistantMsg('a2')])).toBeNull();
  });

  it('skips a malformed trailing user record and falls back to an earlier valid one', () => {
    const messages: SessionMessage[] = [
      userMsg('u1', [{ type: 'text', text: 'valid' }]),
      // trailing user with no id → malformed, must be skipped
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'no-id' }] },
    ];
    const payload = getLastUserPayload(messages);
    expect(payload!.messageID).toBe('u1');
    expect(payload!.parts).toEqual([{ type: 'text', text: 'valid' }]);
  });

  it('treats a user message with no usable parts as malformed (null when it is the only one)', () => {
    expect(getLastUserPayload([userMsg('u1', [])])).toBeNull();
    expect(
      getLastUserPayload([{ info: { id: 'u1', role: 'user' } }]),
    ).toBeNull();
  });
});
