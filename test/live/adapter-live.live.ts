/**
 * Live adapter integration harness (OPT-IN).
 *
 * Resolves the two review items that were blocked on the absence of a live
 * OpenCode (see `_bmad-output/implementation-artifacts/deferred-work.md`):
 *   1. The OpenCode plugin adapter has never been exercised against a real
 *      OpenCode — hooks, SDK-backed effects, config load, control tool.
 *   2. The replay part-type round-trip (`toPromptInputParts`) was unverified
 *      end-to-end: does a stored user turn's parts get ACCEPTED by a live
 *      `session.promptAsync` after projection?
 *
 * This file drives the REAL adapter against a real OpenCode over the SDK. It
 * is excluded from the default unit suite (`*.live.ts` never matches vitest's
 * default include) and self-skips unless BOTH `OPENCODE_LIVE=1` and
 * `OPENROUTER_API_KEY` are set.
 *
 * COST / SIDE EFFECTS — read before running: it PREFERS an already-running
 * OpenCode (`OPENCODE_BASE_URL`, default `http://127.0.0.1:4096`) and boots its
 * own only if none answers. When it connects to a running instance, the seed
 * and replay prompts are REAL, billed model calls that also create sessions and
 * messages IN THAT SHARED INSTANCE's state (in a throwaway temp `directory`).
 * Calls use the cheapest configured model and are aborted as soon as the user
 * turn is persisted to bound cost, but they are not free and not fully isolated
 * from a developer's running server. Point `OPENCODE_BASE_URL` at a disposable
 * instance if that matters.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';

import { getLastUserPayload, parseModelId } from '../../src/index.js';
import { ModelEscalator } from '../../src/plugin/model-escalator.js';
import { toPromptInputParts } from '../../src/plugin/helpers.js';

/** The cheap-first chain from `opencode.json` (cheapest → strongest). */
const MODELS = [
  'openrouter/google/gemini-2.5-flash-lite',
  'openrouter/openai/gpt-4.1-nano',
  'openrouter/openai/gpt-5-nano',
] as const;

const LIVE =
  process.env.OPENCODE_LIVE === '1' && !!process.env.OPENROUTER_API_KEY;
const usingLiveConfig = process.argv.some((a) =>
  a.includes('vitest.live.config'),
);
if (usingLiveConfig && !LIVE) {
  throw new Error(
    'npm run test:live requires OPENCODE_LIVE=1 and OPENROUTER_API_KEY',
  );
}
const live = LIVE ? describe : describe.skip;

/**
 * An already-running OpenCode to prefer over booting our own. Defaults to
 * OpenCode's standard serve port; override with `OPENCODE_BASE_URL`. Booting a
 * second in-process server while one is already running contends on OpenCode's
 * global state and fails, so we connect to the live instance when it answers
 * and only spawn our own as a fallback.
 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:4096';

/** A recorded SDK call: the options passed and the resolved `{data,error}`. */
type Recorded = { options: any; result: any };

/** Is a server answering `/config` at `baseUrl`? Short-timeout, never throws. */
async function reachable(baseUrl: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    const res = await fetch(`${baseUrl}/config`, { signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** Poll `pred` until true or `timeoutMs` elapses; throws `message` on timeout. */
async function waitFor(
  pred: () => Promise<boolean>,
  message: string,
  { timeoutMs = 20_000, intervalMs = 300 } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out: ${message}`);
}

live('adapter ⇄ live OpenCode (opt-in: OPENCODE_LIVE=1 + OPENROUTER_API_KEY)', () => {
  let closeServer: () => void = () => {};
  let realClient: any;
  let spyClient: any;
  let hooks: any;
  let directory: string;

  const calls: {
    promptAsync: Recorded[];
    abort: Recorded[];
    messages: Recorded[];
    showToast: Recorded[];
    log: Recorded[];
  } = { promptAsync: [], abort: [], messages: [], showToast: [], log: [] };

  /** Wrap the methods the adapter uses so the harness can assert on them. */
  function makeSpy(client: any) {
    return {
      ...client,
      session: {
        ...client.session,
        async promptAsync(options: any) {
          const result = await client.session.promptAsync(options);
          calls.promptAsync.push({ options, result });
          return result;
        },
        async abort(options: any) {
          const result = await client.session.abort(options);
          calls.abort.push({ options, result });
          return result;
        },
        async messages(options: any) {
          const result = await client.session.messages(options);
          calls.messages.push({ options, result });
          return result;
        },
      },
      tui: {
        ...client.tui,
        async showToast(options: any) {
          const result = await client.tui.showToast(options);
          calls.showToast.push({ options, result });
          return result;
        },
      },
      app: {
        ...client.app,
        async log(options: any) {
          const result = await client.app.log(options);
          calls.log.push({ options, result });
          return result;
        },
      },
    };
  }

  /** Create a session and seed a real last USER turn cheaply (prompt+abort). */
  async function seededSession(): Promise<string> {
    const created = await realClient.session.create({
      query: { directory },
      body: { title: 'live-verify' },
    });
    expect(created.error, `session.create: ${JSON.stringify(created.error)}`).toBeUndefined();
    const sessionID = created.data.id as string;

    const seed = await realClient.session.promptAsync({
      path: { id: sessionID },
      query: { directory },
      body: {
        model: parseModelId(MODELS[0]),
        parts: [{ type: 'text', text: 'Reply with the single word: ok' }],
      },
    });
    expect(seed.error, `seed promptAsync: ${JSON.stringify(seed.error)}`).toBeUndefined();
    // `promptAsync` returns before the user turn is persisted, so poll until the
    // turn is replayable (this is exactly what the adapter's replay path reads),
    // THEN abort to bound the seed generation's cost.
    await waitFor(async () => {
      const msgs = await realClient.session.messages({
        path: { id: sessionID },
        query: { directory },
      });
      return getLastUserPayload(msgs.data) !== null;
    }, `seed user turn never persisted for ${sessionID}`);
    await realClient.session.abort({ path: { id: sessionID }, query: { directory } });
    return sessionID;
  }

  const callHook = (name: string, input: any, output?: any) =>
    hooks[name](input, output);

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'escalator-live-'));
    // Minimal project marker so OpenCode treats the temp dir as a project.
    writeFileSync(join(directory, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json' }));

    // Prefer the already-running approved OpenCode; boot our own only if none
    // answers (a second server contends on OpenCode's global state and fails).
    const baseUrl = process.env.OPENCODE_BASE_URL?.trim() || DEFAULT_BASE_URL;
    if (await reachable(baseUrl)) {
      realClient = createOpencodeClient({ baseUrl, directory });
      closeServer = () => {}; // never close a server this harness didn't start
    } else {
      const started = await createOpencode({ config: { model: MODELS[0] } });
      realClient = started.client;
      closeServer = () => started.server.close();
    }
    spyClient = makeSpy(realClient);

    hooks = await ModelEscalator(
      { client: spyClient, directory } as any,
      { models: MODELS.map((model) => ({ model })) },
    );
  }, 180_000);

  afterAll(() => {
    try {
      closeServer();
    } catch {
      /* ignore */
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('constructs the adapter and exposes all four live hook surfaces + status control', async () => {
    expect(typeof hooks['tool.execute.after']).toBe('function');
    expect(typeof hooks['event']).toBe('function');
    expect(typeof hooks['chat.message']).toBe('function');
    expect(typeof hooks.tool?.model_escalator_control?.execute).toBe('function');

    const res = await hooks.tool.model_escalator_control.execute(
      { action: 'status' },
      { sessionID: 'ses_probe' } as any,
    );
    const status = JSON.parse(res.output);
    expect(status).toHaveProperty('stage');
    expect(status).toHaveProperty('activeModel');
  });

  it('round-trips a real user turn through session.promptAsync via the adapter mapping (item 2)', async () => {
    const sessionID = await seededSession();

    const msgs = await realClient.session.messages({
      path: { id: sessionID },
      query: { directory },
    });
    expect(msgs.error, `messages: ${JSON.stringify(msgs.error)}`).toBeUndefined();

    const payload = getLastUserPayload(msgs.data);
    expect(payload, 'expected a replayable user message').not.toBeNull();

    const inputParts = toPromptInputParts(payload!.parts);
    expect(inputParts.length, 'mapping yielded no input parts').toBeGreaterThan(0);
    // No output-only field survived the projection.
    for (const p of inputParts as any[]) {
      expect(p).not.toHaveProperty('sessionID');
      expect(p).not.toHaveProperty('messageID');
    }

    // THE round-trip proof: the live server accepts the mapped parts (204/no error).
    const replay = await realClient.session.promptAsync({
      path: { id: sessionID },
      query: { directory },
      body: {
        model: parseModelId(MODELS[1]),
        parts: inputParts,
        messageID: payload!.messageID,
      },
    });
    expect(replay.error, `replay promptAsync rejected mapped parts: ${JSON.stringify(replay.error)}`).toBeUndefined();
    await realClient.session.abort({ path: { id: sessionID }, query: { directory } });
  });

  it('drives the real adapter through an escalation: fail → edit → identical fail ⇒ abort + replay on the next model (item 1)', async () => {
    const sessionID = await seededSession();

    // Establish the task at stage 0 on the cheapest model.
    await callHook('chat.message', {
      sessionID,
      messageID: 'msg_task_1',
      model: { providerID: 'openrouter', modelID: 'google/gemini-2.5-flash-lite' },
    });

    const failOutput = 'FAILED tests/test_math.py::test_add\nE   assert 1 == 2';
    const bashInput = (callID: string) => ({
      tool: 'bash',
      sessionID,
      callID,
      args: { command: 'pytest -q' },
    });
    const bashOutput = { title: '', output: failOutput, metadata: { exit: 1 } };

    // 1st failing test → repeat 1.
    await callHook('tool.execute.after', bashInput('c1'), bashOutput);
    // A successful edit in this session → arms the code-change gate.
    await callHook(
      'tool.execute.after',
      { tool: 'edit', sessionID, callID: 'c2', args: {} },
      { title: '', output: 'edited', metadata: { success: true } },
    );

    const promptsBefore = calls.promptAsync.length;
    const abortsBefore = calls.abort.length;

    // 2nd IDENTICAL failing test (same fingerprint, code changed) → escalate.
    await callHook('tool.execute.after', bashInput('c3'), bashOutput);

    // Escalation must have aborted the stuck generation and replayed on models[1].
    expect(calls.abort.length, 'escalation did not abort').toBeGreaterThan(abortsBefore);

    const replays = calls.promptAsync.slice(promptsBefore);
    expect(replays.length, 'escalation did not dispatch a replay').toBeGreaterThan(0);

    const replay = replays[replays.length - 1]!;
    expect(replay.options.body.model).toEqual(parseModelId(MODELS[1]));
    expect(Array.isArray(replay.options.body.parts)).toBe(true);
    expect(replay.options.body.parts.length).toBeGreaterThan(0);
    expect(replay.options.path?.id).toBe(sessionID);
    // The live server accepted the adapter's own replay dispatch.
    expect(replay.result.error, `adapter replay rejected: ${JSON.stringify(replay.result.error)}`).toBeUndefined();

    await realClient.session.abort({ path: { id: sessionID }, query: { directory } });
  });

  it('app.log succeeds headless; tui.showToast is tolerated when no TUI is attached', async () => {
    const logged = await spyClient.app.log({
      body: { service: 'model-escalator-live', level: 'info', message: 'live smoke' },
    });
    expect(logged.error, `app.log: ${JSON.stringify(logged.error)}`).toBeUndefined();

    // A headless server has no TUI; showToast may error. Record, don't fail.
    let toastOk = true;
    let toastNote = '';
    try {
      const toast = await spyClient.tui.showToast({
        body: { message: 'live smoke', variant: 'info' },
      });
      toastOk = toast.error === undefined;
      if (!toastOk) toastNote = JSON.stringify(toast.error);
    } catch (err) {
      toastOk = false;
      toastNote = String(err);
    }
    // eslint-disable-next-line no-console
    console.log(`[live] tui.showToast ok=${toastOk} ${toastNote}`);
    // app.log already asserted above; toast may legitimately fail headless.
    expect(logged.error).toBeUndefined();
  });
});
