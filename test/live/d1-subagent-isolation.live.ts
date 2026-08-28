/**
 * D1 live probe — OpenCode subagent session model (spec §8).
 *
 * Question: when a subagent runs, does it share the parent `sessionID` (so its
 * test/edit hooks would advance the parent's Category-B counter) or does it get
 * its own session with `parentID` set (so `Map<sessionID, RuntimeState>` already
 * isolates)?
 *
 * Cost: cheapest configured model; abort the spawn as soon as a child session
 * appears. Structural `session.create({ parentID })` is free (no model).
 *
 * Isolated from the default suite (`*.live.ts`). Requires OPENCODE_LIVE=1 and
 * OPENROUTER_API_KEY. Prefer an already-running OpenCode; boot the installed
 * binary only if none answers.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import type { Event, Session } from '@opencode-ai/sdk';

import { parseModelId } from '../../src/index.js';

const CHEAP = 'openrouter/google/gemini-2.5-flash-lite';

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

const DEFAULT_BASE_URL = 'http://127.0.0.1:4096';
const OPENCODE_BIN_DIR = '/home/test/.opencode/bin';

const D1_COMMAND = 'd1-subagent';

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

async function waitFor<T>(
  pred: () => Promise<T | undefined>,
  message: string,
  { timeoutMs = 25_000, intervalMs = 250 } = {},
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await pred();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out: ${message}`);
}

function isSession(value: unknown): value is Session {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Session).id === 'string'
  );
}

live('D1 subagent isolation ⇄ live OpenCode', () => {
  let closeServer: () => void = () => {};
  let client: ReturnType<typeof createOpencodeClient>;
  let directory: string;
  let bootedOwnServer = false;
  const events: Event[] = [];
  const eventCtl = new AbortController();
  let pump: Promise<void> | undefined;
  const spawned = new Set<string>();

  async function replyAllow(ev: Event): Promise<void> {
    if (ev.type !== 'permission.updated') return;
    const sessionID = ev.properties.sessionID;
    const permissionID = ev.properties.id;
    if (!sessionID || !permissionID) return;
    await client.postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID },
      query: { directory },
      body: { response: 'always' },
    });
  }

  async function childrenOf(parentID: string): Promise<Session[]> {
    const res = await client.session.children({
      path: { id: parentID },
      query: { directory },
    });
    if (res.error || !Array.isArray(res.data)) return [];
    return res.data.filter(isSession);
  }

  async function createParent(): Promise<string> {
    const created = await client.session.create({
      query: { directory },
      body: { title: 'd1-parent' },
    });
    expect(created.error, `session.create: ${JSON.stringify(created.error)}`).toBeUndefined();
    const id = created.data?.id;
    expect(typeof id).toBe('string');
    spawned.add(id!);
    return id!;
  }

  async function abortQuiet(id: string): Promise<void> {
    try {
      await client.session.abort({ path: { id }, query: { directory } });
    } catch {
      /* already idle / gone */
    }
  }

  beforeAll(async () => {
    const path = process.env.PATH ?? '';
    if (!path.split(':').includes(OPENCODE_BIN_DIR)) {
      process.env.PATH = `${OPENCODE_BIN_DIR}:${path}`;
    }

    directory = mkdtempSync(join(tmpdir(), 'escalator-d1-'));
    writeFileSync(
      join(directory, 'opencode.json'),
      JSON.stringify({ $schema: 'https://opencode.ai/config.json' }),
    );

    const baseUrl = process.env.OPENCODE_BASE_URL?.trim() || DEFAULT_BASE_URL;
    if (await reachable(baseUrl)) {
      client = createOpencodeClient({ baseUrl, directory });
      closeServer = () => {};
      bootedOwnServer = false;
    } else {
      const started = await createOpencode({
        hostname: '127.0.0.1',
        timeout: 30_000,
        config: {
          model: CHEAP,
          permission: { edit: 'allow', bash: 'allow' },
          command: {
            [D1_COMMAND]: {
              template:
                'Reply with the single word: ok. Do not use any tools. Do not write files.',
              description: 'D1 subagent-isolation probe',
              agent: 'general',
              subtask: true,
            },
          },
        },
      });
      client = createOpencodeClient({ baseUrl: started.server.url, directory });
      closeServer = () => started.server.close();
      bootedOwnServer = true;
    }

    const sub = await client.event.subscribe({
      query: { directory },
      signal: eventCtl.signal,
    } as any);
    pump = (async () => {
      try {
        for await (const ev of sub.stream as AsyncIterable<Event>) {
          events.push(ev);
          void replyAllow(ev).catch(() => {});
        }
      } catch {
        /* aborted */
      }
    })();
  }, 180_000);

  afterAll(async () => {
    for (const id of spawned) await abortQuiet(id);
    eventCtl.abort();
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
    if (pump) await Promise.race([pump, new Promise((r) => setTimeout(r, 500))]);
  });

  it('structural: session.create({ parentID }) yields a distinct child session', async () => {
    const parentID = await createParent();
    const child = await client.session.create({
      query: { directory },
      body: { parentID, title: 'd1-child-structural' },
    });
    expect(child.error, `child create: ${JSON.stringify(child.error)}`).toBeUndefined();
    const childID = child.data?.id;
    expect(typeof childID).toBe('string');
    spawned.add(childID!);

    expect(childID).not.toBe(parentID);
    expect(child.data?.parentID).toBe(parentID);

    const kids = await childrenOf(parentID);
    expect(kids.map((s) => s.id)).toContain(childID);

    // eslint-disable-next-line no-console
    console.log(
      `[d1] structural parent=${parentID} child=${childID} parentID=${child.data?.parentID}`,
    );
  });

  it('spawn: invoking the general subagent creates a distinct child session', async () => {
    const parentID = await createParent();
    const kidsBefore = new Set((await childrenOf(parentID)).map((s) => s.id));

    // Prefer the deterministic subtask command when we booted the server with it.
    // Fall back to an @general mention plus an explicit task-tool instruction.
    let dispatchedVia = 'none';
    if (bootedOwnServer) {
      // session.command is synchronous to completion — do not await it
      // before we can observe+abort the child (bounds the billed run).
      void client.session
        .command({
          path: { id: parentID },
          query: { directory },
          body: {
            command: D1_COMMAND,
            arguments: '',
            agent: 'general',
          },
        })
        .then((cmd) => {
          if (cmd.error) {
            // eslint-disable-next-line no-console
            console.log(`[d1] command spawn rejected: ${JSON.stringify(cmd.error)}`);
          }
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.log(`[d1] command spawn threw: ${String(err)}`);
        });
      dispatchedVia = 'command:subtask';
    }

    const findChild = async (): Promise<Session | undefined> => {
      const fromApi = (await childrenOf(parentID)).find((s) => !kidsBefore.has(s.id));
      if (fromApi) return fromApi;
      for (const ev of events) {
        if (ev.type !== 'session.created') continue;
        const info = ev.properties.info;
        if (info.parentID === parentID && info.id !== parentID) return info;
      }
      return undefined;
    };

    let child: Session | undefined;
    if (bootedOwnServer) {
      try {
        child = await waitFor(findChild, `child via ${dispatchedVia}`, {
          timeoutMs: 15_000,
        });
      } catch {
        await abortQuiet(parentID);
      }
    }

    if (!child) {
      const cheapModel = parseModelId(CHEAP);
      if (!cheapModel) throw new Error(`unparseable model id: ${CHEAP}`);
      const mention = await client.session.promptAsync({
        path: { id: parentID },
        query: { directory },
        body: {
          model: cheapModel,
          parts: [
            { type: 'agent', name: 'general' },
            {
              type: 'text',
              text:
                'You MUST invoke the general subagent via the task tool. ' +
                'Do not answer yourself. Task prompt: Reply with the single word ok and stop. Do not use tools.',
            },
          ],
        },
      });
      expect(
        mention.error,
        `mention promptAsync: ${JSON.stringify(mention.error)}`,
      ).toBeUndefined();
      dispatchedVia = 'prompt:@general+task';
      try {
        child = await waitFor(findChild, `child via ${dispatchedVia}`, {
          timeoutMs: 40_000,
        });
      } catch (err) {
        await abortQuiet(parentID);
        const parentMsgs = await client.session.messages({
          path: { id: parentID },
          query: { directory },
        });
        const listed = await childrenOf(parentID);
        const created = events
          .filter((e) => e.type === 'session.created')
          .map((e) =>
            e.type === 'session.created'
              ? { id: e.properties.info.id, parentID: e.properties.info.parentID }
              : e,
          );
        // eslint-disable-next-line no-console
        console.log(
          `[d1] spawn failed via=${dispatchedVia} children=${JSON.stringify(listed.map((s) => ({ id: s.id, parentID: s.parentID })))} created=${JSON.stringify(created)} parentParts=${JSON.stringify(
            (parentMsgs.data ?? []).map((m) => ({
              role: m.info.role,
              sessionID: m.info.sessionID,
              agent: 'agent' in m.info ? (m.info as { agent?: string }).agent : undefined,
              parts: m.parts.map((p) => p.type),
            })),
          )}`,
        );
        throw err;
      }
    }

    expect(child, 'subagent spawn produced no child session').toBeDefined();
    if (!child) throw new Error('no child session');
    spawned.add(child.id);
    await abortQuiet(parentID);
    await abortQuiet(child.id);

    expect(child.id, 'subagent reused the parent sessionID').not.toBe(parentID);
    expect(child.parentID).toBe(parentID);

    const parentMsgs = await client.session.messages({
      path: { id: parentID },
      query: { directory },
    });
    const childMsgs = await client.session.messages({
      path: { id: child.id },
      query: { directory },
    });
    expect(parentMsgs.error).toBeUndefined();
    expect(childMsgs.error).toBeUndefined();

    for (const m of parentMsgs.data ?? []) {
      expect(m.info.sessionID).toBe(parentID);
    }
    for (const m of childMsgs.data ?? []) {
      expect(m.info.sessionID).toBe(child.id);
    }

    const childAgents = (childMsgs.data ?? [])
      .map((m) => ('agent' in m.info ? (m.info as { agent?: string }).agent : undefined))
      .filter((a): a is string => typeof a === 'string' && a.length > 0);

    // eslint-disable-next-line no-console
    console.log(
      `[d1] spawn via=${dispatchedVia} parent=${parentID} child=${child.id} ` +
        `parentID=${child.parentID} childAgents=${JSON.stringify(childAgents)} ` +
        `parentMsgs=${parentMsgs.data?.length ?? 0} childMsgs=${childMsgs.data?.length ?? 0}`,
    );
  });
});
