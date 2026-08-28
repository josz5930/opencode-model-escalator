import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ModelEscalator from '../src/plugin/model-escalator.js';
import * as pluginEntry from '../src/plugin/model-escalator.js';
import {
  loadUserConfig,
  toolDidMutate,
  readExitCode,
  errorToSignal,
  toPromptInputParts,
} from '../src/plugin/helpers.js';

// These tests exercise the ADAPTER offline (no network, no OpenCode server):
// the sidecar config loader (the documented bare-package install path), the
// pure attribution/classification helpers, and a recorded adapter contract that
// drives the critical hook feedback paths through a faked SDK client
// (2026-08-25 finding 17).

const M0 = 'openrouter/cheap';
const M1 = 'openrouter/mid';

// --- finding 17: sidecar loader coverage ------------------------------------

describe('loadUserConfig — config sources (CFG-2, AC-14)', () => {
  it('reads the documented .opencode/escalator.json sidecar for a bare-package load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'esc-sidecar-'));
    try {
      mkdirSync(join(dir, '.opencode'));
      const cfg = { models: [{ model: M0 }, { model: M1 }] };
      writeFileSync(join(dir, '.opencode', 'escalator.json'), JSON.stringify(cfg));

      // A bare-package load delivers options === undefined; the sidecar is used.
      expect(loadUserConfig(dir, undefined)).toEqual(cfg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inline options win over the sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'esc-sidecar-'));
    try {
      mkdirSync(join(dir, '.opencode'));
      writeFileSync(
        join(dir, '.opencode', 'escalator.json'),
        JSON.stringify({ models: [{ model: M0 }] }),
      );
      const inline = { models: [{ model: M1 }] };
      expect(loadUserConfig(dir, inline)).toEqual(inline);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no sidecar and no options (⇒ resolveConfig fails loudly)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'esc-sidecar-'));
    try {
      expect(loadUserConfig(dir, undefined)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a malformed (non-JSON) sidecar rather than silently ignoring it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'esc-sidecar-'));
    try {
      mkdirSync(join(dir, '.opencode'));
      writeFileSync(join(dir, '.opencode', 'escalator.json'), '{ not json');
      expect(() => loadUserConfig(dir, undefined)).toThrow(/not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the sidecar is not a JSON object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'esc-sidecar-'));
    try {
      mkdirSync(join(dir, '.opencode'));
      writeFileSync(join(dir, '.opencode', 'escalator.json'), '[1,2,3]');
      expect(() => loadUserConfig(dir, undefined)).toThrow(/must contain a JSON object/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a non-object options value (fail loudly, no fall-through)', () => {
    expect(() => loadUserConfig(undefined, 'nope')).toThrow(/must be an object/);
    expect(() => loadUserConfig(undefined, [1, 2])).toThrow(/must be an object/);
  });
});

// --- finding 11: repair-cycle edit attribution ------------------------------

describe('toolDidMutate — positive-evidence attribution (finding 11)', () => {
  it('trusts an explicit success signal', () => {
    expect(toolDidMutate({ metadata: { success: true } })).toBe(true);
    expect(toolDidMutate({ success: true })).toBe(true);
    expect(toolDidMutate({ metadata: { edits: 3 } })).toBe(true);
    expect(toolDidMutate({ edits: 3 })).toBe(true);
  });

  it('does NOT arm on explicit failure evidence', () => {
    expect(toolDidMutate({ error: 'locked path' })).toBe(false);
    expect(toolDidMutate({ metadata: { success: false } })).toBe(false);
    expect(toolDidMutate({ metadata: { exit: 1 } })).toBe(false);
    expect(toolDidMutate({ status: 'failed' })).toBe(false);
    expect(toolDidMutate({ metadata: { edits: 0 } })).toBe(false); // no-op run
  });

  it('a status channel that did not confirm success is treated as no change', () => {
    // Presence of a status field the tool could have set to success, but didn't.
    expect(toolDidMutate({ status: 'pending' })).toBe(false);
  });

  it('only a shape with NO status channel falls back to trusting the run', () => {
    expect(toolDidMutate({ title: 'edited', output: '<diff>' })).toBe(true);
    expect(toolDidMutate('edited')).toBe(true);
  });
});

describe('readExitCode / errorToSignal (defensive parsing)', () => {
  it('reads a clean integer exit code, else undefined', () => {
    expect(readExitCode({ exit: 0 })).toBe(0);
    expect(readExitCode({ exit: 1 })).toBe(1);
    expect(readExitCode({ exit: '2' })).toBe(2);
    expect(readExitCode({ exit: 'abc' })).toBeUndefined();
    expect(readExitCode(null)).toBeUndefined();
    expect(readExitCode({})).toBeUndefined();
  });

  it('flattens an APIError session-error payload to { status, message }', () => {
    const sig = errorToSignal({
      name: 'APIError',
      data: { statusCode: 429, message: 'rate limited' },
    });
    expect(sig.status).toBe(429);
    expect(sig.message).toContain('APIError');
    expect(sig.message).toContain('rate limited');
  });

  it('returns an empty signal for a non-object error', () => {
    expect(errorToSignal(null)).toEqual({});
    expect(errorToSignal('boom')).toEqual({});
  });
});

// --- finding 17: recorded adapter contract (faked client, no network) -------

const USER_MSG = {
  info: { id: 'msg_user_1', role: 'user', sessionID: 'ses_stored' },
  parts: [
    {
      type: 'text',
      text: 'implement the feature',
      id: 'prt_1',
      sessionID: 'ses_stored',
      messageID: 'msg_user_1',
    },
  ],
};

type ClientCalls = {
  log: unknown[];
  toast: unknown[];
  abort: unknown[];
  messages: unknown[];
  promptAsync: { path?: { id: string }; body: { model: unknown; parts: unknown[]; messageID?: string } }[];
};

function makeFakeClient(
  opts: {
    toastError?: boolean;
    messagesError?: unknown;
    promptError?: unknown;
    messagesData?: unknown;
    abortError?: unknown;
  } = {},
) {
  const calls: ClientCalls = { log: [], toast: [], abort: [], messages: [], promptAsync: [] };
  const client = {
    app: {
      log: async (a: unknown) => {
        calls.log.push(a);
        return {};
      },
    },
    tui: {
      showToast: async (a: unknown) => {
        calls.toast.push(a);
        return opts.toastError ? { error: 'no tui attached' } : {};
      },
    },
    session: {
      abort: async (a: unknown) => {
        calls.abort.push(a);
        return opts.abortError !== undefined ? { error: opts.abortError } : {};
      },
      messages: async (a: unknown) => {
        calls.messages.push(a);
        if (opts.messagesError !== undefined) return { error: opts.messagesError };
        return { data: opts.messagesData ?? [USER_MSG] };
      },
      promptAsync: async (a: {
        path?: { id: string };
        body: { model: unknown; parts: unknown[]; messageID?: string };
      }) => {
        calls.promptAsync.push(a);
        if (opts.promptError !== undefined) return { error: opts.promptError };
        return {};
      },
    },
  };
  return { client, calls };
}

const bashInput = (sessionID: string) => ({
  tool: 'bash',
  sessionID,
  callID: `c-${Math.random()}`,
  args: { command: 'pytest -q' },
});
const FAIL = { title: '', output: 'FAILED test_x\nE   assert 1 == 2', metadata: { exit: 1 } };

describe('adapter contract — critical hook feedback paths (finding 17)', () => {
  it('drives a capability escalation: fail → edit → identical fail ⇒ abort + replay(models[1])', async () => {
    const { client, calls } = makeFakeClient();
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }] },
    );
    const SID = 'ses_a';

    await hooks['chat.message']({
      sessionID: SID,
      messageID: 'msg_task_1',
      model: { providerID: 'openrouter', modelID: 'cheap' },
    });

    await hooks['tool.execute.after'](bashInput(SID), FAIL); // repeat 1
    await hooks['tool.execute.after'](
      { tool: 'edit', sessionID: SID, callID: 'e1', args: {} },
      { title: '', output: 'edited', metadata: { success: true } },
    ); // arm code-change gate

    const abortsBefore = calls.abort.length;
    const promptsBefore = calls.promptAsync.length;

    await hooks['tool.execute.after'](bashInput(SID), FAIL); // identical fail ⇒ escalate

    expect(calls.abort.length).toBeGreaterThan(abortsBefore);
    const replays = calls.promptAsync.slice(promptsBefore);
    expect(replays.length).toBeGreaterThan(0);
    const replay = replays[replays.length - 1]!;
    expect(replay.body.model).toEqual({ providerID: 'openrouter', modelID: 'mid' });
    expect(Array.isArray(replay.body.parts)).toBe(true);
    expect(replay.body.parts.length).toBeGreaterThan(0);
    expect(replay.path?.id).toBe(SID);
    expect(replay.body.messageID).toBe('msg_user_1');
    expect(replay.body.parts).toEqual([{ type: 'text', text: 'implement the feature' }]);
    for (const p of replay.body.parts as object[]) {
      expect(p).not.toHaveProperty('sessionID');
      expect(p).not.toHaveProperty('messageID');
    }
  });

  it('drives Category-A feedback: a session.error 429 re-dispatches the SAME model (no de-escalation)', async () => {
    const { client, calls } = makeFakeClient();
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }], infra_retry_cooldown_ms: 0 },
    );
    const SID = 'ses_b';

    const promptsBefore = calls.promptAsync.length;
    await hooks['event']({
      event: {
        type: 'session.error',
        properties: {
          sessionID: SID,
          error: { name: 'APIError', data: { statusCode: 429, message: 'rate limited' } },
        },
      },
    });

    // Category-A recovery aborts then re-dispatches the last user turn under models[0].
    const retries = calls.promptAsync.slice(promptsBefore);
    expect(calls.abort.length).toBe(1);
    expect(retries.length).toBe(1);
    expect(retries[0]!.body.model).toEqual({ providerID: 'openrouter', modelID: 'cheap' });
  });

  it('cheap-first: a new task observed on a stronger model is rebound to models[0]', async () => {
    const { client, calls } = makeFakeClient();
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }] },
    );
    const SID = 'ses_c';

    await hooks['chat.message']({
      sessionID: SID,
      messageID: 'msg_task_1',
      model: { providerID: 'openrouter', modelID: 'mid' }, // stronger leftover
    });

    expect(calls.abort.length).toBe(1);
    expect(calls.promptAsync.length).toBe(1);
    expect(calls.promptAsync[0]!.body.model).toEqual({ providerID: 'openrouter', modelID: 'cheap' });
  });

  it('finding 16: a failed toast falls back to a durable log line (message never dropped)', async () => {
    const { client, calls } = makeFakeClient({ toastError: true });
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      // max_infra_retries 0 ⇒ a session.error immediately notifies (INFRA_EXHAUSTED).
      { models: [{ model: M0 }, { model: M1 }], max_infra_retries: 0, notify: true },
    );
    const SID = 'ses_d';

    await hooks['event']({
      event: {
        type: 'session.error',
        properties: {
          sessionID: SID,
          error: { name: 'APIError', data: { statusCode: 429, message: 'rate limited' } },
        },
      },
    });

    // Toast was attempted and errored; the message fell back to app.log.
    expect(calls.toast.length).toBe(1);
    const toastBody = (calls.toast[0] as { body?: { message?: string } })?.body?.message;
    expect(toastBody).toBe('Infrastructure failure persists — automatic retries stopped');
    expect(
      calls.log.some(
        (l) =>
          (l as { body?: { message?: string } })?.body?.message ===
          'notify: Infrastructure failure persists — automatic retries stopped',
      ),
    ).toBe(true);
  });
});

describe('adapter — 2026-08-26 review patches', () => {
  it('P43: the plugin entry exports exactly one unique function', () => {
    const fns = Object.values(pluginEntry).filter((v) => typeof v === 'function');
    expect(new Set(fns).size).toBe(1);
    expect(fns[0]).toBe(ModelEscalator);
  });

  it('P27/AC-13: model_escalator_control execute returns stage, model, repeats, config', async () => {
    const { client } = makeFakeClient();
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }] },
    );
    const SID = 'ses_ctrl';
    const ctx = { sessionID: SID };

    const st = JSON.parse(
      (await hooks.tool.model_escalator_control.execute({ action: 'status' }, ctx)).output,
    );
    expect(st.stage).toBe(0);
    expect(st.activeModel).toBe(M0);
    expect(st.repeats).toBe(0);
    expect(st.config.models).toEqual([M0, M1]);

    await hooks.tool.model_escalator_control.execute({ action: 'disable' }, ctx);
    const disabled = JSON.parse(
      (await hooks.tool.model_escalator_control.execute({ action: 'status' }, ctx)).output,
    );
    expect(disabled.enabled).toBe(false);

    await hooks.tool.model_escalator_control.execute({ action: 'enable' }, ctx);
    await hooks.tool.model_escalator_control.execute({ action: 'reset' }, ctx);
    const reset = JSON.parse(
      (await hooks.tool.model_escalator_control.execute({ action: 'status' }, ctx)).output,
    );
    expect(reset.enabled).toBe(true);
    expect(reset.stage).toBe(0);
  });

  it('P30: ModelEscalator with undefined options and no sidecar throws /models/', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'esc-noconfig-'));
    try {
      await expect(
        ModelEscalator({ client: makeFakeClient().client, directory: dir } as any, undefined),
      ).rejects.toThrow(/models/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P30: empty options: {} falls through to the sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'esc-emptyopts-'));
    try {
      mkdirSync(join(dir, '.opencode'));
      const cfg = { models: [{ model: M0 }] };
      writeFileSync(join(dir, '.opencode', 'escalator.json'), JSON.stringify(cfg));
      expect(loadUserConfig(dir, {})).toEqual(cfg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P29: a failed/no-op edit does not arm the repair-cycle; no escalation', async () => {
    const { client, calls } = makeFakeClient();
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }] },
    );
    const SID = 'ses_noop';
    await hooks['chat.message']({
      sessionID: SID,
      messageID: 'msg_task_1',
      model: { providerID: 'openrouter', modelID: 'cheap' },
    });
    await hooks['tool.execute.after'](bashInput(SID), FAIL);
    await hooks['tool.execute.after'](
      { tool: 'edit', sessionID: SID, callID: 'e-fail', args: {} },
      { error: 'locked path' },
    );
    await hooks['tool.execute.after'](bashInput(SID), FAIL);
    expect(calls.abort.length).toBe(0);
    expect(calls.promptAsync.length).toBe(0);

    await hooks['tool.execute.after'](
      { tool: 'edit', sessionID: SID, callID: 'e-ok', args: {} },
      { title: '', output: 'edited', metadata: { success: true } },
    );
    await hooks['tool.execute.after'](bashInput(SID), FAIL);
    expect(calls.abort.length).toBeGreaterThan(0);
  });

  it('P26: a late bash result from the aborted generation does not count at stage 1', async () => {
    const { client, calls } = makeFakeClient();
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }] },
    );
    const SID = 'ses_stale';
    await hooks['chat.message']({
      sessionID: SID,
      messageID: 'msg_task_1',
      model: { providerID: 'openrouter', modelID: 'cheap' },
    });

    const late = { tool: 'bash', sessionID: SID, callID: 'late-1', args: { command: 'pytest -q' } };
    await hooks['tool.execute.before'](late);
    await hooks['tool.execute.after'](bashInput(SID), FAIL);
    await hooks['tool.execute.after'](
      { tool: 'edit', sessionID: SID, callID: 'e1', args: {} },
      { title: '', output: 'edited', metadata: { success: true } },
    );
    await hooks['tool.execute.after'](bashInput(SID), FAIL); // escalate, bumps generation

    const abortsAfterEscalation = calls.abort.length;
    const promptsAfterEscalation = calls.promptAsync.length;

    // Consume the self-replay so pendingReplay is cleared.
    await hooks['chat.message']({
      sessionID: SID,
      messageID: 'msg_task_1',
      model: { providerID: 'openrouter', modelID: 'mid' },
    });

    // Late result whose before-stamp is the pre-escalation epoch.
    await hooks['tool.execute.after'](late, FAIL);

    expect(calls.abort.length).toBe(abortsAfterEscalation);
    expect(calls.promptAsync.length).toBe(promptsAfterEscalation);
  });

  it('P37: messages.error translates to dispatch-failure notify + terminal', async () => {
    const { client, calls } = makeFakeClient({ messagesError: { code: 'boom' } });
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }] },
    );
    const SID = 'ses_err';
    await hooks['chat.message']({
      sessionID: SID,
      messageID: 'msg_task_1',
      model: { providerID: 'openrouter', modelID: 'cheap' },
    });
    await hooks['tool.execute.after'](bashInput(SID), FAIL);
    await hooks['tool.execute.after'](
      { tool: 'edit', sessionID: SID, callID: 'e1', args: {} },
      { title: '', output: 'edited', metadata: { success: true } },
    );
    await hooks['tool.execute.after'](bashInput(SID), FAIL);

    const toast = (calls.toast[0] as { body?: { message?: string } })?.body?.message;
    expect(toast).toBe('Escalation dispatch failed — automation stopped');
    const st = JSON.parse(
      (await hooks.tool.model_escalator_control.execute({ action: 'status' }, { sessionID: SID }))
        .output,
    );
    expect(st.terminated).toBe(true);
  });

  it('P37/P12: empty projection after toPromptInputParts refuses promptAsync', async () => {
    const { client, calls } = makeFakeClient({
      messagesData: [
        {
          info: { id: 'msg_user_1', role: 'user' },
          parts: [{ type: 'reasoning', text: 'thinking', id: 'r1' }],
        },
      ],
    });
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }] },
    );
    const SID = 'ses_empty';
    await hooks['chat.message']({
      sessionID: SID,
      messageID: 'msg_task_1',
      model: { providerID: 'openrouter', modelID: 'cheap' },
    });
    await hooks['tool.execute.after'](bashInput(SID), FAIL);
    await hooks['tool.execute.after'](
      { tool: 'edit', sessionID: SID, callID: 'e1', args: {} },
      { title: '', output: 'edited', metadata: { success: true } },
    );
    await hooks['tool.execute.after'](bashInput(SID), FAIL);

    expect(calls.promptAsync.length).toBe(0);
    const toast = (calls.toast[0] as { body?: { message?: string } })?.body?.message;
    expect(toast).toBe('Escalation dispatch failed — automation stopped');
  });

  it('P38: after adapter escalation, re-entering chat.message with pending model does not reset', async () => {
    const { client, calls } = makeFakeClient();
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }] },
    );
    const SID = 'ses_reentry';
    await hooks['chat.message']({
      sessionID: SID,
      messageID: 'msg_task_1',
      model: { providerID: 'openrouter', modelID: 'cheap' },
    });
    await hooks['tool.execute.after'](bashInput(SID), FAIL);
    await hooks['tool.execute.after'](
      { tool: 'edit', sessionID: SID, callID: 'e1', args: {} },
      { title: '', output: 'edited', metadata: { success: true } },
    );
    await hooks['tool.execute.after'](bashInput(SID), FAIL);

    const abortsAfter = calls.abort.length;
    await hooks['chat.message']({
      sessionID: SID,
      messageID: 'msg_task_1',
      model: { providerID: 'openrouter', modelID: 'mid' },
    });
    expect(calls.abort.length).toBe(abortsAfter);

    const st = JSON.parse(
      (await hooks.tool.model_escalator_control.execute({ action: 'status' }, { sessionID: SID }))
        .output,
    );
    expect(st.stage).toBe(1);
  });

  it('D1: child sessionID with agent=general does not escalate the parent', async () => {
    const { client, calls } = makeFakeClient();
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }] },
    );
    const PARENT = 'ses_parent';
    const CHILD = 'ses_child';

    await hooks['chat.message']({
      sessionID: PARENT,
      messageID: 'msg_parent',
      model: { providerID: 'openrouter', modelID: 'cheap' },
    });
    await hooks['tool.execute.after'](bashInput(PARENT), FAIL);
    await hooks['tool.execute.after'](
      { tool: 'edit', sessionID: PARENT, callID: 'e-p', args: {} },
      { title: '', output: 'edited', metadata: { success: true } },
    );
    await hooks['tool.execute.after'](bashInput(PARENT), FAIL);

    const parentAborts = calls.abort.filter((a: any) => a.path?.id === PARENT).length;
    const parentPrompts = calls.promptAsync.filter((a: any) => a.path?.id === PARENT).length;

    await hooks['chat.message']({
      sessionID: CHILD,
      messageID: 'msg_child',
      agent: 'general',
      model: { providerID: 'openrouter', modelID: 'cheap' },
    });
    await hooks['tool.execute.after'](bashInput(CHILD), FAIL);
    await hooks['tool.execute.after'](
      { tool: 'edit', sessionID: CHILD, callID: 'e-c', args: {} },
      { title: '', output: 'edited', metadata: { success: true } },
    );
    await hooks['tool.execute.after'](bashInput(CHILD), FAIL);

    expect(calls.abort.filter((a: any) => a.path?.id === PARENT)).toHaveLength(parentAborts);
    expect(calls.promptAsync.filter((a: any) => a.path?.id === PARENT)).toHaveLength(
      parentPrompts,
    );
    expect(calls.abort.some((a: any) => a.path?.id === CHILD)).toBe(true);
    expect(calls.promptAsync.some((a: any) => a.path?.id === CHILD)).toBe(true);

    const parentSt = JSON.parse(
      (await hooks.tool.model_escalator_control.execute({ action: 'status' }, { sessionID: PARENT }))
        .output,
    );
    const childSt = JSON.parse(
      (await hooks.tool.model_escalator_control.execute({ action: 'status' }, { sessionID: CHILD }))
        .output,
    );
    expect(parentSt.stage).toBe(1);
    expect(childSt.stage).toBe(1);
  });

  it('P16: empty sessionID on tool.execute.after is ignored', async () => {
    const { client, calls } = makeFakeClient();
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }] },
    );
    await hooks['tool.execute.after'](bashInput(''), FAIL);
    expect(calls.abort.length).toBe(0);
  });
});

describe('adapter — patch coverage (T2–T4)', () => {
  const infraError = (sessionID: string) => ({
    event: {
      type: 'session.error',
      properties: {
        sessionID,
        error: { name: 'APIError', data: { statusCode: 429, message: 'rate limited' } },
      },
    },
  });

  it('T2: notify:false suppresses all toasts (master switch)', async () => {
    const { client, calls } = makeFakeClient();
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }], max_infra_retries: 0, notify: false },
    );
    // An infra give-up would normally toast the terminal message; the master
    // switch must suppress the toast AND its durable-log fallback entirely.
    await hooks['event'](infraError('ses_quiet'));
    expect(calls.toast.length).toBe(0);
    expect(
      calls.log.some(
        (l: any) =>
          typeof l?.body?.message === 'string' && l.body.message.startsWith('notify:'),
      ),
    ).toBe(false);
  });

  it('T3: a Category-A retry whose session went stale during backoff is dropped after sleep', async () => {
    const { client, calls } = makeFakeClient();
    const COOLDOWN = 40;
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      {
        models: [{ model: M0 }, { model: M1 }],
        infra_retry_cooldown_ms: COOLDOWN,
        max_infra_retries: 2,
      },
    );
    const SID = 'ses_stale_retry';

    const promptsBefore = calls.promptAsync.length;
    await hooks['event'](infraError(SID));
    // The abort fires synchronously; the same-model re-dispatch is deferred
    // behind the backoff timer. Make the session non-current before it elapses.
    expect(calls.abort.length).toBe(1);
    await hooks.tool.model_escalator_control.execute({ action: 'disable' }, { sessionID: SID });

    // Wait out the backoff: the post-sleep isCurrent() gate must drop the stale
    // dispatch rather than replay an obsolete model.
    await new Promise((r) => setTimeout(r, COOLDOWN + 40));
    expect(calls.promptAsync.slice(promptsBefore).length).toBe(0);
  });

  it('T4: replay forwards the original turn\'s agent on the promptAsync body', async () => {
    const { client, calls } = makeFakeClient({
      messagesData: [
        {
          info: { id: 'msg_u', role: 'user', sessionID: 'ses_x', agent: 'build' },
          parts: [
            { type: 'text', text: 'do it', id: 'p1', sessionID: 'ses_x', messageID: 'msg_u' },
          ],
        },
      ],
    });
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }] },
    );
    const SID = 'ses_agent';

    await hooks['chat.message']({
      sessionID: SID,
      messageID: 'm1',
      model: { providerID: 'openrouter', modelID: 'cheap' },
    });
    await hooks['tool.execute.after'](bashInput(SID), FAIL);
    await hooks['tool.execute.after'](
      { tool: 'edit', sessionID: SID, callID: 'e1', args: {} },
      { title: '', output: 'edited', metadata: { success: true } },
    );
    await hooks['tool.execute.after'](bashInput(SID), FAIL); // escalate → replay

    const replay = calls.promptAsync.at(-1)!;
    expect((replay.body as any).agent).toBe('build');
  });

  it('T4: dispose() clears pending Category-A backoff timers', async () => {
    const { client, calls } = makeFakeClient();
    const COOLDOWN = 30;
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      {
        models: [{ model: M0 }, { model: M1 }],
        infra_retry_cooldown_ms: COOLDOWN,
        max_infra_retries: 2,
      },
    );
    const SID = 'ses_dispose';

    const promptsBefore = calls.promptAsync.length;
    await hooks['event'](infraError(SID));
    expect(calls.abort.length).toBe(1); // retry scheduled behind the backoff timer

    await hooks.dispose();
    // The timer was cleared: even after the cooldown elapses, the deferred
    // re-dispatch never fires (an un-cleared timer would have replayed by now).
    await new Promise((r) => setTimeout(r, COOLDOWN + 40));
    expect(calls.promptAsync.slice(promptsBefore).length).toBe(0);
  });

  it('T4: a result-level error from session.abort surfaces as a terminal stop', async () => {
    const { client, calls } = makeFakeClient({ abortError: 'abort rejected' });
    const hooks: any = await ModelEscalator(
      { client, directory: undefined } as any,
      { models: [{ model: M0 }, { model: M1 }] },
    );
    const SID = 'ses_abort_err';

    await hooks['chat.message']({
      sessionID: SID,
      messageID: 'm1',
      model: { providerID: 'openrouter', modelID: 'cheap' },
    });
    await hooks['tool.execute.after'](bashInput(SID), FAIL);
    await hooks['tool.execute.after'](
      { tool: 'edit', sessionID: SID, callID: 'e1', args: {} },
      { title: '', output: 'edited', metadata: { success: true } },
    );
    await hooks['tool.execute.after'](bashInput(SID), FAIL); // escalate → abort throws

    // abort threw on its result-level error: no replay dispatched, the session is
    // terminally stopped, and the user is notified.
    expect(calls.abort.length).toBeGreaterThan(0);
    expect(calls.promptAsync.length).toBe(0);
    const st = JSON.parse(
      (
        await hooks.tool.model_escalator_control.execute({ action: 'status' }, { sessionID: SID })
      ).output,
    );
    expect(st.terminated).toBe(true);
    expect(
      calls.toast.some(
        (t: any) =>
          typeof t?.body?.message === 'string' && /dispatch failed|stopped/i.test(t.body.message),
      ),
    ).toBe(true);
  });
});

describe('toPromptInputParts re-export path', () => {
  it('is imported from helpers, not the plugin entry', () => {
    expect(typeof toPromptInputParts).toBe('function');
    expect(Object.keys(pluginEntry).sort()).toEqual(['ModelEscalator', 'default']);
  });
});
