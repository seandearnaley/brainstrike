/**
 * BST-1932 AT-13, ported to ADR-0010: "Child interactions are marked
 * interrupted" and "A pending child approval does not survive a restart; it
 * shows as interrupted." The shipped specs' restart setup is kept: a
 * grandchild pauses in one real host process, and every later step runs in
 * fresh host processes over the same root. Its decision is refused, nothing
 * is written, and the parent reads the outcome once, on its next turn. Only
 * the model is scripted.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decodeHostRecord, type HostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock, StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost } from '../src/client.js';
import { HOST_RESULT_SCHEMAS, type HostLogRow } from '../src/protocol.js';
import {
  closeFixtureHost,
  createFixtureCloseControl,
  type FixtureCloseControl,
  fixtureControlEnvironment,
  removeFixtureRoot,
} from './fixtures/cooperative-host-fixture.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const platformPath = fileURLToPath(
  new URL('./fixtures/process-platform-children.mjs', import.meta.url)
);
const exec = promisify(execFile);
const STALE = /is stale or belongs to another run/u;
const roots = new Map<string, FixtureCloseControl | undefined>();
const closers: (() => Promise<void>)[] = [];

const CASES = {
  answer: {
    args: ['interaction', 'resume', '--resume-data', '{"answer":"App, Docs"}'],
    kind: 'question',
    tool: 'ask_user',
  },
  approve: {
    args: ['interaction', 'respond', '--decision', 'approve'],
    kind: 'approval',
    tool: 'write_file',
  },
  decline: {
    args: ['interaction', 'respond', '--decision', 'deny'],
    kind: 'approval',
    tool: 'write_file',
  },
  // No decision before the restart reaches it; the restart alone interrupts it.
  interrupt: { args: undefined, kind: 'approval', tool: 'write_file' },
  'plan-approve': {
    args: [
      'interaction',
      'resume',
      '--resume-data',
      '{"action":"approved","feedback":"Keep the original scope."}',
    ],
    kind: 'plan',
    tool: 'submit_plan',
  },
  'plan-reject': {
    args: [
      'interaction',
      'resume',
      '--resume-data',
      '{"action":"rejected","feedback":"Keep the original scope."}',
    ],
    kind: 'plan',
    tool: 'submit_plan',
  },
} as const;
type Decision = keyof typeof CASES;

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-at13-child-restart-'));
  roots.set(root, process.platform === 'win32' ? createFixtureCloseControl(root) : undefined);
  return root;
}

function cli(root: string, tool: string, args: readonly string[]): Promise<unknown> {
  const control = roots.get(root);
  return exec(process.execPath, [cliPath, '--root', root, '--platform', platformPath, ...args], {
    env: {
      ...process.env,
      ...(control ? fixtureControlEnvironment(control) : {}),
      BRAINSTRIKE_CHILD_RESTART_TOOL: tool,
    },
    windowsHide: true,
  }).then(({ stdout }) => JSON.parse(stdout));
}

/** The CLI's refusal text; an accepted command fails the test. */
async function refused(root: string, tool: string, args: readonly string[]): Promise<string> {
  const outcome = await cli(root, tool, args).then(
    () => undefined,
    (error: unknown) => String((error as { stderr?: unknown }).stderr)
  );
  if (outcome === undefined) {
    throw new Error('The host accepted a decision for an interrupted child');
  }
  return outcome;
}

async function owner(root: string): Promise<HostRecord> {
  return decodeHostRecord(JSON.parse(await readFile(join(root, 'host.json'), 'utf8')));
}

async function released(root: string): Promise<void> {
  await expect.poll(() => RootLock.inspect(root)?.owner.released, { timeout: 30_000 }).toBe(true);
}

async function stop(root: string, host: HostRecord): Promise<void> {
  if (processStartTime(host.pid) === host.start) {
    const control = roots.get(root);
    if (control) {
      await closeFixtureHost(host, control);
    } else {
      process.kill(host.pid, 'SIGTERM');
    }
  }
  await expect.poll(() => processStartTime(host.pid)).not.toBe(host.start);
  await released(root);
}

async function rowsOf(root: string): Promise<(threadId: string) => Promise<HostLogRow[]>> {
  const store = await StateStore.open(root);
  const read = async (threadId: string) => (await store.read(threadId)) as HostLogRow[];
  closers.push(() => store.close());
  return read;
}

async function lines(root: string, name: string): Promise<string[]> {
  return (await readFile(join(root, name), 'utf8').catch(() => '')).split('\n').filter(Boolean);
}

afterEach(async (context) => {
  for (const close of closers.splice(0)) {
    await close();
  }
  for (const [root] of roots) {
    const live = await owner(root).catch(() => undefined);
    if (live) {
      await stop(root, live);
    }
    if (context.task.result?.state !== 'fail') {
      await removeFixtureRoot(root);
    }
  }
  roots.clear();
});

const finishedOutcomes = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : []));

test.for(Object.keys(CASES) as Decision[])(
  'a paused grandchild is interrupted by a real host restart; its decision is refused and the parent reads it once (%s)',
  async (decision) => {
    const { args, kind, tool } = CASES[decision];
    const root = await freshRoot();

    // Process A: the grandchild pauses on its interaction; nothing has run.
    const { threadId } = HOST_RESULT_SCHEMAS['thread/start'].parse(
      await cli(root, tool, ['thread', 'start'])
    );
    await released(root);
    await cli(root, tool, [
      'run',
      'start',
      '--thread',
      threadId,
      '--model',
      'scripted',
      '--prompt',
      'Delegate the tree.',
    ]);
    const first = await owner(root);
    const client = await attachAgentHost(first);
    let childThreadId = '';
    let grandchildThreadId = '';
    let pause: HostLogRow['event'] | undefined;
    try {
      await expect
        .poll(
          async () => {
            const [child] = (await client.request('thread/children', { threadId })).children;
            childThreadId = child?.threadId ?? '';
            const [grandchild] = child
              ? (await client.request('thread/children', { threadId: child.threadId })).children
              : [];
            grandchildThreadId = grandchild?.threadId ?? '';
            pause = grandchild
              ? (
                  await client.request('thread/read', { fromSeq: 0, threadId: grandchild.threadId })
                ).rows
                  .map((row) => row.event)
                  .find((event) => event.type === 'interaction.requested')
              : undefined;
            return pause?.type;
          },
          { timeout: 30_000 }
        )
        .toBe('interaction.requested');
    } finally {
      await client.close();
    }
    if (pause?.type !== 'interaction.requested') {
      throw new Error('The grandchild did not pause');
    }
    expect(pause).toMatchObject({ kind, toolId: tool });
    const target = [
      '--thread',
      grandchildThreadId,
      '--run',
      pause.runId,
      '--interaction',
      pause.interactionId,
    ];
    await stop(root, first);

    // Process B: the decision reaches an interrupted child and is refused.
    if (args) {
      expect(await refused(root, tool, [...args, ...target])).toMatch(STALE);
    } else {
      await cli(root, tool, ['thread', 'read', '--thread', grandchildThreadId]);
    }
    await released(root);
    // A later process: the parent's next turn reads the child's outcome.
    const { runId: next } = HOST_RESULT_SCHEMAS['run/start'].parse(
      await cli(root, tool, [
        'run',
        'start',
        '--thread',
        threadId,
        '--model',
        'scripted',
        '--prompt',
        'What happened?',
      ])
    );
    await released(root);

    // A third phase: the same decision is refused again, and the outcome is not redelivered.
    expect(await refused(root, tool, [...(args ?? CASES.approve.args), ...target])).toMatch(STALE);
    await released(root);
    const { runId: after } = HOST_RESULT_SCHEMAS['run/start'].parse(
      await cli(root, tool, [
        'run',
        'start',
        '--thread',
        threadId,
        '--model',
        'scripted',
        '--prompt',
        'Anything else?',
      ])
    );
    await released(root);

    const read = await rowsOf(root);
    const grandchildRows = await read(grandchildThreadId);
    expect(grandchildRows.filter(({ event }) => event.type === 'interaction.responded')).toEqual(
      []
    );
    expect(grandchildRows.find(({ event }) => event.type === 'run.finished')?.event).toMatchObject({
      detail: 'Host restarted; child runs are not resumed',
      outcome: 'interrupted',
    });
    expect(finishedOutcomes(await read(childThreadId))).toEqual(['interrupted']);
    const rootRuns = (await read(threadId)).flatMap(({ event }) =>
      event.type === 'run.started'
        ? [
            {
              delivery: event.delivery?.via ?? null,
              states: event.delivery?.entries.map(({ state }) => state) ?? [],
            },
          ]
        : []
    );
    expect(rootRuns).toEqual([
      { delivery: null, states: [] },
      { delivery: 'next-turn', states: ['failed'] },
      { delivery: null, states: [] },
    ]);
    expect(finishedOutcomes(await read(threadId))).toEqual(['completed', 'completed', 'completed']);

    // Nothing was written, and no host called the model while it recovered.
    await expect(readFile(join(root, 'fixture-effect-count'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(root, 'grandchild.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const calls = (await lines(root, 'fixture-model-calls')).map(
      (line) => JSON.parse(line) as { ledgers: number; pid: number; task: string }
    );
    expect(
      calls.filter(({ pid }) => pid !== first.pid).map(({ ledgers, task }) => ({ ledgers, task }))
    ).toEqual([
      { ledgers: 1, task: 'What happened?' },
      { ledgers: 1, task: 'Anything else?' },
    ]);
    expect(
      calls
        .filter(({ pid }) => pid === first.pid)
        .map(({ task }) => task)
        .sort()
    ).toEqual(['Delegate the tree.', 'Delegate the tree.', 'LEVEL_1', 'LEVEL_2']);
    expect(new Set([next, after]).size).toBe(2);
    // Every phase ran in its own host process.
    const pids = (await lines(root, 'fixture-platform-pids')).map(Number);
    expect(new Set(pids).size).toBe(pids.length);
    expect(pids.length).toBeGreaterThanOrEqual(5);
  }
);
