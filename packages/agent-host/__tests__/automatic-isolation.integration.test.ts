/**
 * ADR-0034, owner decisions 2026-11-11: Automatic isolation. A thread starts in
 * the repository's own checkout. When its first file edit would land in a
 * folder another thread's run in progress has already edited, the host does
 * not run that edit: it makes a worktree of that checkout, moves the thread
 * into it and the same turn carries on there. A thread that only reads creates
 * nothing, and threads that take turns share the checkout.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  refusalError,
} from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { withHostDelegationTools } from '../src/child-runs.js';
import { HostCore } from '../src/core.js';
import type {
  HostEnteredWorktree,
  HostPlatform,
  HostRunAdmissionRequest,
  HostTool,
} from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import {
  blocked,
  type CallOptions,
  crashableStorePort,
  finished,
  stream,
  text,
  toolCall,
  toolCalls,
  userTexts,
  worker,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const LOCAL = 'local-root';
const MOVED = 'Continue the task in the worktree';
type Scripted = ReturnType<typeof stream>;

/** The newest user message's text, and how many tool results answered it so far. */
function latestTurn(call: CallOptions): { readonly answered: number; readonly text: string } {
  const index = call.prompt.findLastIndex((message) => message.role === 'user');
  const latest = call.prompt[index];
  return {
    answered: call.prompt.slice(index).filter((message) => message.role === 'tool').length,
    text:
      latest?.role === 'user'
        ? latest.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
        : '',
  };
}

/** One scripted model for every thread: a thread is told apart by how its first message starts. */
function scripted(
  threads: Readonly<
    Record<
      string,
      (turn: ReturnType<typeof latestTurn>, call: CallOptions) => Promise<Scripted> | Scripted
    >
  >
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (call) => {
      const first = userTexts(call)[0] ?? '';
      const script = Object.entries(threads).find(([prefix]) => first.startsWith(prefix))?.[1];
      if (!script) {
        throw new Error(`No script for a thread that starts with "${first}"`);
      }
      return await script(latestTurn(call), call);
    },
  });
}

const write = (path: string, callId: string, root?: string) =>
  toolCall('write_file', { content: `${path} content`, path, ...(root ? { root } : {}) }, callId);

/** Writes its file, then keeps working until the host closes: a run in progress that has edited. */
const writesThenWorks =
  (path: string, callId: string) =>
  (turn: ReturnType<typeof latestTurn>, call: CallOptions): Scripted =>
    turn.answered === 0 ? stream(write(path, callId)) : blocked(call);

/** Writes its file where it is, and again in the worktree the host moves it into. */
const writesWhereverItIs =
  (path: string, callId: string) =>
  (turn: ReturnType<typeof latestTurn>): Scripted => {
    const id = turn.text.includes(MOVED) ? `${callId}-moved` : callId;
    return stream(turn.answered === 0 ? write(path, id) : text('Done.'));
  };

interface Harness {
  /** Set to make the next worktree creation fail with this cause. */
  failCreate?: Error;
  /** The uncommitted paths the fake checkout reports, of those it is asked about. */
  uncommitted: string[];
}

async function host(
  model: MockLanguageModelV4,
  options: {
    /** The threads whose edits ask a person first; every other edit is allowed. */
    readonly asks?: (threadId: string) => boolean;
    /** Holds every write inside its tool until it resolves, so an edit stays in flight. */
    readonly holdWrites?: Promise<void>;
  } = {}
) {
  const base = await mkdtemp(join(tmpdir(), 'bs-automatic-isolation-'));
  const local = join(base, 'checkout');
  await mkdir(local);
  const storeRoot = join(base, 'store');
  await mkdir(storeRoot);
  const store = await StateStore.open(storeRoot);
  const folders = new Map([[LOCAL, local]]);
  const harness: Harness = { uncommitted: [] };
  const created: { readonly rootId: string; readonly runId: string; readonly threadId: string }[] =
    [];
  const askedUncommitted: { readonly paths: readonly string[]; readonly rootId: string }[] = [];
  const requests: HostRunAdmissionRequest[] = [];
  const started = new Map<string, PromiseWithResolvers<void>>();
  const startedWriting = (path: string): PromiseWithResolvers<void> => {
    const known = started.get(path) ?? Promise.withResolvers<void>();
    started.set(path, known);
    return known;
  };
  /** The file tools of a run that works in `bound`, as the desktop admits them per run. */
  const fileTools = (bound: string): Record<string, HostTool> => ({
    read_file: {
      description: 'Read a workspace file',
      execute: async (input) => {
        const { path } = input as { path: string };
        return { content: await readFile(join(folders.get(bound) ?? '', path), 'utf8') };
      },
      identity: 'native-read-generation-1',
      inputSchema: z.object({ path: z.string() }),
      risk: 'read',
    },
    write_file: {
      approvalTarget: (input) => {
        const rootId = (input as { root?: string }).root ?? bound;
        return folders.has(rootId) ? { displayName: rootId, rootId } : undefined;
      },
      description: 'Write a workspace file',
      execute: async (input, context) => {
        const { content, path, root } = input as { content: string; path: string; root?: string };
        const rootId = root ?? bound;
        const rootPath = folders.get(rootId);
        if (!(rootPath && context.edits)) {
          throw new Error('The write has no folder or no edit tracker');
        }
        const absolutePath = join(rootPath, path);
        await context.edits.track({ absolutePath, op: 'write', rootId, rootPath }, async () => {
          startedWriting(path).resolve();
          await options.holdWrites;
          await writeFile(absolutePath, content);
        });
        return { written: path };
      },
      identity: 'native-write-generation-1',
      inputSchema: z.object({
        content: z.string(),
        path: z.string(),
        root: z.string().optional(),
      }),
      risk: 'edit',
    },
  });
  const delegation = {
    personas: [worker],
    settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS },
  };
  const platform: HostPlatform = {
    // As the desktop admission does: each run's tools and configuration name its bound folder.
    admitRun: async (request) => {
      requests.push(request);
      const bound = request.workspaceBinding?.operatingRootId;
      const tools = withHostDelegationTools(fileTools(bound ?? LOCAL), delegation);
      return {
        configuration: bound ? { boundWorkspaceRootId: bound } : {},
        delegation,
        model,
        snapshot: {
          configuration: {},
          maxSteps: 6,
          toolIdentities: Object.fromEntries(
            Object.entries(tools).map(([id, tool]) => [id, tool.identity])
          ),
        },
        tools,
      };
    },
    checkoutIsolation: {
      create: async ({ rootId, runId, threadId }): Promise<HostEnteredWorktree> => {
        if (harness.failCreate) {
          throw harness.failCreate;
        }
        created.push({ rootId, runId, threadId });
        const name = `quiet-otter-${created.length}`;
        const path = join(base, name);
        await mkdir(path);
        const root = { displayName: name, path, rootId: `worktree-root-${created.length}` };
        folders.set(root.rootId, path);
        return {
          branch: `bs/${name}`,
          localRootId: rootId,
          root,
          worktreeId: `worktree-${created.length}`,
        };
      },
      uncommitted: async ({ paths, rootId }) => {
        askedUncommitted.push({ paths: [...paths], rootId });
        return paths.filter((path) => harness.uncommitted.includes(path));
      },
    },
    close: async () => undefined,
    readPermissionPolicy: (threadId) => ({
      policies: {
        ...DEFAULT_PERMISSION_POLICIES,
        edit: threadId && options.asks?.(threadId) ? 'ask' : 'allow',
        read: 'allow',
      },
      yolo: false,
    }),
    validateWorkspaceBinding: async () => undefined,
  };
  let writer = crashableStorePort(store);
  let core = await HostCore.open(writer.port, platform, () => () => undefined);
  const crashed: HostCore[] = [];
  cleanup.push(async () => {
    await core.close();
    // A crashed Core can no longer commit its own teardown; only its joins matter here.
    await Promise.allSettled(crashed.map((dead) => dead.close()));
    await store.close();
    await rm(base, { force: true, recursive: true });
  });
  return {
    askedUncommitted,
    core: () => core,
    /** The process dies mid-run; a fresh Core recovers over the same committed store. */
    crash: async (): Promise<HostCore> => {
      writer.dead = true;
      crashed.push(core);
      writer = crashableStorePort(store);
      core = await HostCore.open(writer.port, platform, () => () => undefined);
      return core;
    },
    created,
    files: async (rootId: string): Promise<string[]> =>
      (await readdir(folders.get(rootId) ?? '')).sort(),
    harness,
    requests,
    /** Starts a thread's turn; the thread's first message must start with its script's prefix. */
    run: async (threadId: string, prompt: string): Promise<string> =>
      (await core.startRun({ commandId: randomUUID(), modelId: 'scripted', prompt, threadId }))
        .runId,
    /** Resolves once a write of `path` is inside its tool, changing the folder. */
    startedWriting: (path: string): Promise<void> => startedWriting(path).promise,
    store,
    /** A new thread; `bound` works in the repository's own checkout, as a thread opened on it does. */
    thread: async (bound = true): Promise<string> => {
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      if (bound) {
        await core.updateWorkspaceBinding({
          commandId: randomUUID(),
          patch: {
            operatingRootDisplayName: 'beaker',
            operatingRootId: LOCAL,
            operatingRootPath: local,
          },
          threadId,
        });
      }
      return threadId;
    },
  };
}

type Host = Awaited<ReturnType<typeof host>>;

async function rowsWhere(
  core: HostCore,
  threadId: string,
  done: (rows: readonly HostLogRow[]) => boolean
): Promise<readonly HostLogRow[]> {
  let rows: readonly HostLogRow[] = [];
  await expect
    .poll(
      async () => {
        rows = await core.read(threadId, 0);
        return done(rows);
      },
      { timeout: 15_000 }
    )
    .toBe(true);
  return rows;
}

const startedRuns = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.started' ? [event] : []));
const bindingUpdates = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'workspace.binding.updated' ? [event] : []));
const moves = (rows: readonly HostLogRow[]) =>
  bindingUpdates(rows).filter((event) => event.enteredBy !== undefined);
const sharedNotes = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'checkout.shared' ? [event] : []));
const outputOf = (rows: readonly HostLogRow[], toolCallId: string) =>
  rows.flatMap(({ event }) =>
    event.type === 'effect.finished' && event.toolCallId === toolCallId ? [event.output] : []
  )[0];

/** Thread A has edited the shared checkout and its run is still in progress. */
async function firstThreadIsWriting(hosted: Host): Promise<string> {
  const first = await hosted.thread();
  await hosted.run(first, 'A: write a.txt and keep working.');
  await hosted.startedWriting('a.txt');
  return first;
}

/** The thread's turn went on in a worktree: its first run ended and the host's next one finished. */
async function turnFinishedAfter(
  hosted: Host,
  threadId: string,
  firstRunId: string
): Promise<readonly HostLogRow[]> {
  return await rowsWhere(hosted.core(), threadId, (all) => {
    const next = startedRuns(all).find((run) => run.parentMessageId === firstRunId);
    return next !== undefined && all.some(finished(next.runId));
  });
}

test("the second thread's first edit leaves the shared folder unchanged and lands in a worktree", async () => {
  const hosted = await host(
    scripted({
      'A:': writesThenWorks('a.txt', 'a-write'),
      'B:': writesWhereverItIs('b.txt', 'b-write'),
    })
  );
  await firstThreadIsWriting(hosted);
  const second = await hosted.thread();
  const firstRun = await hosted.run(second, 'B: write b.txt.');
  const rows = await turnFinishedAfter(hosted, second, firstRun);

  // Nothing of the second thread reached the folder the first is writing.
  expect(await hosted.files(LOCAL)).toEqual(['a.txt']);
  expect(await hosted.files('worktree-root-1')).toEqual(['b.txt']);
  // The host made one worktree of that checkout, for this thread and run.
  expect(hosted.created).toEqual([{ rootId: LOCAL, runId: firstRun, threadId: second }]);
  // The move went through the binding's own command, and says the host made it and why.
  const [moved] = moves(rows);
  expect(moves(rows)).toHaveLength(1);
  expect(moved).toMatchObject({
    binding: {
      checkoutBranch: 'bs/quiet-otter-1',
      checkoutLocalRootId: LOCAL,
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'worktree-1',
      operatingRootId: 'worktree-root-1',
      secondaryRootIds: [LOCAL],
    },
    enteredBy: { cause: 'checkout-contended', runId: firstRun },
  });
  // The refused edit was settled unrun, with a reason the model reads.
  expect(outputOf(rows, 'b-write')).toMatchObject({
    error: { message: expect.stringContaining('bs/quiet-otter-1') },
    ok: false,
  });
  // The same turn carried on in the worktree, in a run the host started there.
  const [, next] = startedRuns(rows);
  expect(next).toMatchObject({ hostPrompt: true, parentMessageId: firstRun, turnId: firstRun });
  expect(rows.find(finished(next?.runId ?? ''))?.event).toMatchObject({ outcome: 'completed' });
  expect(hosted.requests.at(-1)?.workspaceBinding).toMatchObject({
    operatingRootId: 'worktree-root-1',
  });
  expect(rows.find(finished(firstRun))?.event).toMatchObject({ outcome: 'completed' });
});

test('a thread with no folder of its own is moved the same way', async () => {
  const hosted = await host(
    scripted({
      'A:': writesThenWorks('a.txt', 'a-write'),
      'B:': writesWhereverItIs('b.txt', 'b-write'),
    })
  );
  await firstThreadIsWriting(hosted);
  const second = await hosted.thread(false);
  const firstRun = await hosted.run(second, 'B: write b.txt.');
  const rows = await turnFinishedAfter(hosted, second, firstRun);

  expect(await hosted.files(LOCAL)).toEqual(['a.txt']);
  expect(await hosted.files('worktree-root-1')).toEqual(['b.txt']);
  expect(moves(rows)[0]?.binding).toMatchObject({
    checkoutLocalRootId: LOCAL,
    checkoutMode: 'worktree',
    operatingRootId: 'worktree-root-1',
  });
});

test('a second thread that only reads creates nothing', async () => {
  const hosted = await host(
    scripted({
      'A:': writesThenWorks('a.txt', 'a-write'),
      'B:': (turn) =>
        stream(
          turn.answered === 0
            ? toolCall('read_file', { path: 'a.txt' }, 'b-read')
            : text('It says a.txt content.')
        ),
    })
  );
  await firstThreadIsWriting(hosted);
  const second = await hosted.thread();
  const run = await hosted.run(second, 'B: read a.txt.');
  const rows = await rowsWhere(hosted.core(), second, (all) => all.some(finished(run)));

  expect(outputOf(rows, 'b-read')).toEqual({ content: 'a.txt content' });
  expect(hosted.created).toEqual([]);
  expect(moves(rows)).toEqual([]);
  expect(startedRuns(rows)).toHaveLength(1);
});

test('the first thread finished, so the second edits in place', async () => {
  const hosted = await host(
    scripted({
      'A:': (turn) => stream(turn.answered === 0 ? write('a.txt', 'a-write') : text('Done.')),
      'B:': writesWhereverItIs('b.txt', 'b-write'),
    })
  );
  const first = await hosted.thread();
  const firstRun = await hosted.run(first, 'A: write a.txt.');
  await rowsWhere(hosted.core(), first, (all) => all.some(finished(firstRun)));
  const second = await hosted.thread();
  const run = await hosted.run(second, 'B: write b.txt.');
  const rows = await rowsWhere(hosted.core(), second, (all) => all.some(finished(run)));

  // Threads that take turns share the checkout.
  expect(await hosted.files(LOCAL)).toEqual(['a.txt', 'b.txt']);
  expect(hosted.created).toEqual([]);
  expect(moves(rows)).toEqual([]);
  expect(sharedNotes(rows)).toEqual([]);
});

test('two first edits race and exactly one thread moves', async () => {
  const release = Promise.withResolvers<void>();
  const hosted = await host(
    scripted({
      'A:': writesWhereverItIs('a.txt', 'a-write'),
      'B:': writesWhereverItIs('b.txt', 'b-write'),
    }),
    { holdWrites: release.promise }
  );
  const [first, second] = [await hosted.thread(), await hosted.thread()];
  // Neither has recorded an edit when the other's begins: both writes are held in their tools.
  const [firstRun, secondRun] = await Promise.all([
    hosted.run(first, 'A: write a.txt.'),
    hosted.run(second, 'B: write b.txt.'),
  ]);
  await rowsWhere(hosted.core(), first, () => hosted.created.length === 1);
  release.resolve();
  await Promise.all([hosted.core().idle(first), hosted.core().idle(second)]);

  const moved = hosted.created[0]?.threadId;
  const stayed = moved === first ? second : first;
  expect([first, second]).toContain(moved);
  expect(hosted.created).toHaveLength(1);
  // The one that stayed wrote the shared folder; the one that moved wrote its worktree only.
  const stayedFile = stayed === first ? 'a.txt' : 'b.txt';
  const movedFile = stayed === first ? 'b.txt' : 'a.txt';
  expect(await hosted.files(LOCAL)).toEqual([stayedFile]);
  expect(await hosted.files('worktree-root-1')).toEqual([movedFile]);
  expect(moves(await hosted.core().read(stayed, 0))).toEqual([]);
  expect(moves(await hosted.core().read(moved ?? '', 0))).toHaveLength(1);
  expect([firstRun, secondRun]).toContain(hosted.created[0]?.runId);
});

test('every edit of the step that moved the thread is left unrun', async () => {
  const hosted = await host(
    scripted({
      'A:': writesThenWorks('a.txt', 'a-write'),
      'B:': (turn) => {
        if (turn.text.includes(MOVED)) {
          return stream(
            turn.answered === 0
              ? toolCalls([
                  ['write_file', { content: 'b', path: 'b.txt' }, 'b-write-moved'],
                  ['write_file', { content: 'c', path: 'c.txt' }, 'c-write-moved'],
                ])
              : text('Done.')
          );
        }
        return stream(
          toolCalls([
            ['write_file', { content: 'b', path: 'b.txt' }, 'b-write'],
            ['write_file', { content: 'c', path: 'c.txt' }, 'c-write'],
          ])
        );
      },
    })
  );
  await firstThreadIsWriting(hosted);
  const second = await hosted.thread();
  const firstRun = await hosted.run(second, 'B: write b.txt and c.txt.');
  const rows = await turnFinishedAfter(hosted, second, firstRun);

  expect(await hosted.files(LOCAL)).toEqual(['a.txt']);
  expect(await hosted.files('worktree-root-1')).toEqual(['b.txt', 'c.txt']);
  expect(hosted.created).toHaveLength(1);
  expect(outputOf(rows, 'b-write')).toMatchObject({ ok: false });
  expect(outputOf(rows, 'c-write')).toMatchObject({ ok: false });
});

test('a host restarted after the move was committed continues the turn in the worktree', async () => {
  let restarted = false;
  // The thread whose edits ask a person: the second, until its approved edit is settled.
  let asking = '';
  const hosted = await host(
    scripted({
      'A:': writesThenWorks('a.txt', 'a-write'),
      'B:': async (turn, call) => {
        if (turn.text.includes(MOVED)) {
          return stream(turn.answered === 0 ? write('b.txt', 'b-write-moved') : text('Done.'));
        }
        if (turn.answered === 0) {
          return stream(write('b.txt', 'b-write'));
        }
        if (!restarted) {
          // The process dies while the step after the move is in flight.
          return await new Promise<never>((_resolve, reject) => {
            call.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        return stream(text('Carrying on in the worktree.'));
      },
    }),
    { asks: (threadId) => threadId === asking }
  );
  await firstThreadIsWriting(hosted);
  const second = await hosted.thread();
  asking = second;
  const firstRun = await hosted.run(second, 'B: write b.txt.');
  const asked = await rowsWhere(hosted.core(), second, (all) =>
    all.some(({ event }) => event.type === 'interaction.requested')
  );
  const request = asked.find(({ event }) => event.type === 'interaction.requested')?.event;
  if (request?.type !== 'interaction.requested') {
    throw new Error('Expected an approval request');
  }
  await hosted.core().respond({
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: request.interactionId,
    runId: firstRun,
    threadId: second,
  });
  // The approved edit was refused and the move committed; its run's next step is in flight.
  await rowsWhere(hosted.core(), second, (all) => outputOf(all, 'b-write') !== undefined);
  expect(moves(await hosted.core().read(second, 0))).toHaveLength(1);

  restarted = true;
  asking = '';
  await hosted.crash();
  const rows = await turnFinishedAfter(hosted, second, firstRun);

  expect(rows.find(finished(firstRun))?.event).toMatchObject({ outcome: 'completed' });
  expect(startedRuns(rows).find((run) => run.runId !== firstRun)).toMatchObject({
    hostPrompt: true,
    parentMessageId: firstRun,
  });
  expect(hosted.requests.at(-1)?.workspaceBinding).toMatchObject({
    operatingRootId: 'worktree-root-1',
  });
  // The restart made no second worktree and wrote nothing into the shared folder.
  expect(hosted.created).toHaveLength(1);
  expect(await hosted.files(LOCAL)).toEqual(['a.txt']);
  expect(await hosted.files('worktree-root-1')).toEqual(['b.txt']);
});

test("a delegated worker's edit never moves its parent", async () => {
  const CHILD_TASK = 'CHILD_TASK: write w.txt.';
  const hosted = await host(
    new MockLanguageModelV4({
      doStream: async (call) => {
        const first = userTexts(call)[0] ?? '';
        const turn = latestTurn(call);
        if (first.startsWith('A:')) {
          return writesThenWorks('a.txt', 'a-write')(turn, call);
        }
        if (first.includes(CHILD_TASK)) {
          return stream(turn.answered === 0 ? write('w.txt', 'w-write') : text('Worker done.'));
        }
        return stream(
          turn.answered === 0
            ? toolCall(
                'agent-worker',
                { _background: { disposition: 'awaited', enabled: true }, prompt: CHILD_TASK },
                'delegate'
              )
            : text('Parent done.')
        );
      },
    })
  );
  await firstThreadIsWriting(hosted);
  const second = await hosted.thread();
  const run = await hosted.run(second, 'B: delegate the write.');
  const rows = await rowsWhere(hosted.core(), second, (all) => all.some(finished(run)));

  // The worker wrote where its parent works; nothing was created and nobody moved.
  expect(await hosted.files(LOCAL)).toEqual(['a.txt', 'w.txt']);
  expect(hosted.created).toEqual([]);
  expect(moves(rows)).toEqual([]);
  expect(startedRuns(rows)).toHaveLength(1);
});

test('a thread whose workers are still working is not moved, and says it shares the folder', async () => {
  const WORKER_TASK = 'WORKER_TASK: keep working.';
  const hosted = await host(
    new MockLanguageModelV4({
      doStream: async (call) => {
        const first = userTexts(call)[0] ?? '';
        const turn = latestTurn(call);
        if (first.startsWith('A:')) {
          return writesThenWorks('a.txt', 'a-write')(turn, call);
        }
        if (first.includes(WORKER_TASK)) {
          return blocked(call);
        }
        return stream(
          [
            toolCall('agent-worker', { prompt: WORKER_TASK }, 'delegate'),
            write('b.txt', 'b-write'),
          ][turn.answered] ?? text('Parent done.')
        );
      },
    })
  );
  await firstThreadIsWriting(hosted);
  const second = await hosted.thread();
  const run = await hosted.run(second, 'B: delegate, then write b.txt.');
  const rows = await rowsWhere(hosted.core(), second, (all) => all.some(finished(run)));

  // It stays with the worker it dispatched (ADR-0028 rule 5), so its edit ran in place.
  expect(await hosted.files(LOCAL)).toEqual(['a.txt', 'b.txt']);
  expect(hosted.created).toEqual([]);
  expect(moves(rows)).toEqual([]);
  expect(sharedNotes(rows)).toEqual([
    expect.objectContaining({ reason: 'workers-running', runId: run, toolCallId: 'b-write' }),
  ]);
});

test('when the worktree cannot be made, the edit is refused and nothing is written', async () => {
  const hosted = await host(
    scripted({
      'A:': writesThenWorks('a.txt', 'a-write'),
      'B:': (turn) => stream(turn.answered === 0 ? write('b.txt', 'b-write') : text('Blocked.')),
    })
  );
  hosted.harness.failCreate = refusalError(
    'conflict',
    'git.command-failed',
    'fatal: not a git repository'
  );
  await firstThreadIsWriting(hosted);
  const second = await hosted.thread();
  const run = await hosted.run(second, 'B: write b.txt.');
  const rows = await rowsWhere(hosted.core(), second, (all) => all.some(finished(run)));

  expect(await hosted.files(LOCAL)).toEqual(['a.txt']);
  expect(moves(rows)).toEqual([]);
  // The model reads why, in the refused call's result, and the run goes on where it was.
  expect(outputOf(rows, 'b-write')).toMatchObject({
    error: { message: expect.stringContaining('fatal: not a git repository') },
    ok: false,
  });
  expect(startedRuns(rows)).toHaveLength(1);
  expect(rows.find(finished(run))?.event).toMatchObject({ outcome: 'completed' });
});

/** The second thread edited the checkout in a turn of its own, before the first began. */
async function secondThreadEditedEarlier(hosted: Host): Promise<string> {
  const second = await hosted.thread();
  const earlier = await hosted.run(second, 'B: write b1.txt.');
  await rowsWhere(hosted.core(), second, (all) => all.some(finished(earlier)));
  return second;
}

const writesTwoTurns = (turn: ReturnType<typeof latestTurn>): Scripted => {
  if (turn.answered > 0) {
    return stream(text('Done.'));
  }
  if (turn.text.includes(MOVED)) {
    return stream(write('b2.txt', 'b2-write-moved'));
  }
  return stream(
    turn.text.includes('b2.txt') ? write('b2.txt', 'b2-write') : write('b1.txt', 'b1-write')
  );
};

test('a thread with uncommitted edits of its own in the checkout is not moved, and says it shares it', async () => {
  const hosted = await host(
    scripted({ 'A:': writesThenWorks('a.txt', 'a-write'), 'B:': writesTwoTurns })
  );
  const second = await secondThreadEditedEarlier(hosted);
  await firstThreadIsWriting(hosted);
  hosted.harness.uncommitted = ['b1.txt'];
  const run = await hosted.run(second, 'Now write b2.txt.');
  const rows = await rowsWhere(hosted.core(), second, (all) => all.some(finished(run)));

  // Its edit ran in place, beside the work it had not committed.
  expect(await hosted.files(LOCAL)).toEqual(['a.txt', 'b1.txt', 'b2.txt']);
  expect(hosted.created).toEqual([]);
  expect(moves(rows)).toEqual([]);
  expect(hosted.askedUncommitted).toEqual([{ paths: ['b1.txt'], rootId: LOCAL }]);
  // The thread's log says the checkout is shared, and why it was not moved.
  expect(sharedNotes(rows)).toEqual([
    expect.objectContaining({
      reason: 'own-uncommitted-edits',
      root: { displayName: LOCAL, rootId: LOCAL },
      runId: run,
      toolCallId: 'b2-write',
    }),
  ]);
});

test('a thread whose earlier edits were committed is moved like any other', async () => {
  const hosted = await host(
    scripted({ 'A:': writesThenWorks('a.txt', 'a-write'), 'B:': writesTwoTurns })
  );
  const second = await secondThreadEditedEarlier(hosted);
  await firstThreadIsWriting(hosted);
  // The person committed b1.txt: the checkout's last commit holds the thread's earlier work.
  hosted.harness.uncommitted = [];
  const run = await hosted.run(second, 'Now write b2.txt.');
  const rows = await turnFinishedAfter(hosted, second, run);

  expect(await hosted.files(LOCAL)).toEqual(['a.txt', 'b1.txt']);
  expect(await hosted.files('worktree-root-1')).toEqual(['b2.txt']);
  expect(moves(rows)).toHaveLength(1);
  expect(sharedNotes(rows)).toEqual([]);
});

test('an edit in a folder that is not the thread’s own is refused there, never moved', async () => {
  const hosted = await host(
    scripted({
      'A:': writesThenWorks('a.txt', 'a-write'),
      'B:': (turn) => {
        if (turn.text.includes(MOVED)) {
          // In its worktree, the thread reaches back into the checkout it left.
          return stream(
            turn.answered === 0 ? write('b.txt', 'b-write-back', LOCAL) : text('Staying here.')
          );
        }
        return stream(write('b.txt', 'b-write'));
      },
    })
  );
  await firstThreadIsWriting(hosted);
  const second = await hosted.thread();
  const firstRun = await hosted.run(second, 'B: write b.txt.');
  const rows = await turnFinishedAfter(hosted, second, firstRun);

  // One worktree, not one per attempt, and the first thread's folder is untouched.
  expect(hosted.created).toHaveLength(1);
  expect(await hosted.files(LOCAL)).toEqual(['a.txt']);
  expect(outputOf(rows, 'b-write-back')).toMatchObject({ ok: false });
  expect(moves(rows)).toHaveLength(1);
});
