import { describe, it, expect } from 'vitest';

import { toPromptInputParts } from '../src/plugin/helpers.js';
import type { MessagePart } from '../src/replay.js';

/**
 * Offline coverage for the replay part projection (spec I/O matrix rows 1-4).
 * The live half of row 1 (the server actually accepting the mapped parts) and
 * the boot-without-key skip (row 5) live in the opt-in live harness.
 */
describe('toPromptInputParts — output Part → prompt-input part projection', () => {
  it('row 1: a text user turn maps to a bare {type,text} input part', () => {
    const parts: MessagePart[] = [
      {
        type: 'text',
        text: 'fix the failing test',
        id: 'prt_1',
        sessionID: 'ses_1',
        messageID: 'msg_1',
        synthetic: false,
      },
    ];
    expect(toPromptInputParts(parts)).toEqual([
      { type: 'text', text: 'fix the failing test' },
    ]);
  });

  it('row 2: non-input kinds (reasoning/tool/step) are dropped; input kinds kept', () => {
    const parts: MessagePart[] = [
      { type: 'reasoning', text: 'thinking…', id: 'r1', sessionID: 's', messageID: 'm' },
      { type: 'step-start', id: 's1' },
      { type: 'tool', tool: 'bash', id: 't1', state: { status: 'completed' } },
      { type: 'text', text: 'keep me', id: 'x', sessionID: 's', messageID: 'm' },
    ];
    expect(toPromptInputParts(parts)).toEqual([{ type: 'text', text: 'keep me' }]);
  });

  it('row 3: a file part keeps only input fields (no sessionID/messageID/source)', () => {
    const parts: MessagePart[] = [
      {
        type: 'file',
        mime: 'text/plain',
        url: 'file:///tmp/a.txt',
        filename: 'a.txt',
        id: 'f1',
        sessionID: 'ses_1',
        messageID: 'msg_1',
        source: { type: 'file', path: '/tmp/a.txt', text: { value: 'x', start: 0, end: 1 } },
      },
    ];
    expect(toPromptInputParts(parts)).toEqual([
      { type: 'file', mime: 'text/plain', url: 'file:///tmp/a.txt', filename: 'a.txt' },
    ]);
  });

  it('row 3b: a file part without filename omits it', () => {
    const parts: MessagePart[] = [
      { type: 'file', mime: 'image/png', url: 'https://x/y.png', id: 'f2' },
    ];
    expect(toPromptInputParts(parts)).toEqual([
      { type: 'file', mime: 'image/png', url: 'https://x/y.png' },
    ]);
  });

  it('maps an agent part to {type,name}', () => {
    const parts: MessagePart[] = [
      { type: 'agent', name: 'reviewer', id: 'a1', source: { value: '@reviewer', start: 0, end: 9 } },
    ];
    expect(toPromptInputParts(parts)).toEqual([{ type: 'agent', name: 'reviewer' }]);
  });

  it('maps a subtask part to its four input fields', () => {
    const parts: MessagePart[] = [
      {
        type: 'subtask',
        prompt: 'do X',
        description: 'sub',
        agent: 'general',
        id: 'st1',
        sessionID: 's',
        messageID: 'm',
      },
    ];
    expect(toPromptInputParts(parts)).toEqual([
      { type: 'subtask', prompt: 'do X', description: 'sub', agent: 'general' },
    ]);
  });

  it('row 4: parts with no input-compatible kinds project to an empty array', () => {
    const parts: MessagePart[] = [
      { type: 'reasoning', text: 't', id: 'r', sessionID: 's', messageID: 'm' },
      { type: 'step-finish', id: 'sf' },
    ];
    expect(toPromptInputParts(parts)).toEqual([]);
  });

  it('drops malformed input-kind parts (missing required fields)', () => {
    const parts: MessagePart[] = [
      { type: 'text' }, // no text
      { type: 'file', mime: 'text/plain' }, // no url
      { type: 'agent' }, // no name
      { type: 'text', text: 'ok' },
    ];
    expect(toPromptInputParts(parts)).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('drops parts whose required string fields are present but blank', () => {
    const parts: MessagePart[] = [
      { type: 'text', text: '' }, // blank text
      { type: 'file', mime: '', url: 'https://x/y.png' }, // blank mime
      { type: 'file', mime: 'image/png', url: '' }, // blank url
      { type: 'agent', name: '' }, // blank name
      { type: 'subtask', prompt: 'p', description: '', agent: 'g' }, // blank description
      { type: 'text', text: 'kept' },
    ];
    expect(toPromptInputParts(parts)).toEqual([{ type: 'text', text: 'kept' }]);
  });

  it('omits a blank filename but keeps the file part', () => {
    const parts: MessagePart[] = [
      { type: 'file', mime: 'image/png', url: 'https://x/y.png', filename: '' },
    ];
    expect(toPromptInputParts(parts)).toEqual([
      { type: 'file', mime: 'image/png', url: 'https://x/y.png' },
    ]);
  });
});
