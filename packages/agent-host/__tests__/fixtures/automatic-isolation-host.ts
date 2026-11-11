/**
 * The host the Automatic isolation tests run (ADR-0034): real Core over a real
 * state store, scripted models, and file tools that name the folder they
 * change. The platform's part is a fake checkout: it records each worktree
 * the host asks for and reports the uncommitted paths a test sets.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { expect } from 'vitest';
import { z } from 'zod';
import type { HostNoWorktree } from '../../src/checkout-isolation.js';
import { withHostDelegationTools } from '../../src/child-runs.js';
import { HostCore } from '../../src/core.js';
import type {
  HostEnteredWorktree,
  HostPlatform,
  HostRunAdmissionRequest,
  HostTool,
} from '../../src/ports.js';
import type { HostLogRow } from '../../src/protocol.js';
import {
  blocked,
  type CallOptions,
  crashableStorePort,
  finished,
  stream,
  text,
  toolCall,
  userTexts,
  worker,
} from './child-run-host.js';

export const LOCAL = 'local-root';
export const MOVED = 'Continue the task in the worktree';
export type Scripted = ReturnType<typeof stream>;

/** The newest user message's text, and how many tool results answered it so far. */
export function latestTurn(call: CallOptions): {
  readonly answered: number;
  readonly text: string;
} {
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
export function scripted(
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

export const write = (path: string, callId: string, root?: string) =>
  toolCall('write_file', { content: `${path} content`, path, ...(root ? { root } : {}) }, callId);

/** Writes its file, then keeps working until the host closes: a run in progress that has edited. */
export const writesThenWorks =
  (path: string, callId: string) =>
  (turn: ReturnType<typeof latestTurn>, call: CallOptions): Scripted =>
    turn.answered === 0 ? stream(write(path, callId)) : blocked(call);

/** Writes its file where it is, and again in the worktree the host moves it into. */
export const writesWhereverItIs =
  (path: string, callId: string) =>
  (turn: ReturnType<typeof latestTurn>): Scripted => {
    const id = turn.text.includes(MOVED) ? `${callId}-moved` : callId;
    return stream(turn.answered === 0 ? write(path, id) : text('Done.'));
  };

interface Harness {
  /** Set to make the next worktree creation fail with this cause. */
  failCreate?: Error;
  /** Set when the folders cannot be given a worktree, to the platform's reason. */
  noWorktree?: HostNoWorktree['noWorktree'];
  /** The uncommitted paths the fake checkout reports, of those it is asked about. */
  uncommitted: string[];
}

export const DOCS = 'docs-root';

export async function automaticIsolationHost(
  model: MockLanguageModelV4,
  /** Receives the harness teardown; the caller runs it after the test. */
  cleanup: (() => Promise<void>)[],
  options: {
    /** The threads whose edits ask a person first; every other edit is allowed. */
    readonly asks?: (threadId: string) => boolean;
    /** Holds the making of a worktree until it resolves, as `git worktree add` takes time. */
    readonly holdCreate?: Promise<void>;
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
  // A second folder a thread can have open beside the one it works in.
  const docs = join(base, 'docs');
  await mkdir(docs);
  const folders = new Map([
    [LOCAL, local],
    [DOCS, docs],
  ]);
  const harness: Harness = { uncommitted: [] };
  const created: { readonly rootId: string; readonly runId: string; readonly threadId: string }[] =
    [];
  const askedUncommitted: { readonly paths: readonly string[]; readonly rootId: string }[] = [];
  const creating = Promise.withResolvers<void>();
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
      create: async ({
        rootId,
        runId,
        threadId,
      }): Promise<HostEnteredWorktree | HostNoWorktree> => {
        if (harness.failCreate) {
          throw harness.failCreate;
        }
        if (harness.noWorktree) {
          return { noWorktree: harness.noWorktree };
        }
        created.push({ rootId, runId, threadId });
        creating.resolve();
        // As the real one: none of the making reads the run's signal.
        await options.holdCreate;
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
    /** Resolves once the host has begun making a worktree. */
    creating: creating.promise,
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
    /**
     * A new thread; `bound` works in the repository's own checkout, as a thread opened on it
     * does, with `others` open beside it.
     */
    thread: async (bound = true, others: readonly string[] = []): Promise<string> => {
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      if (bound) {
        await core.updateWorkspaceBinding({
          commandId: randomUUID(),
          patch: {
            operatingRootDisplayName: 'beaker',
            operatingRootId: LOCAL,
            operatingRootPath: local,
            ...(others.length > 0 ? { secondaryRootIds: [...others] } : {}),
          },
          threadId,
        });
      }
      return threadId;
    },
  };
}

export type Host = Awaited<ReturnType<typeof automaticIsolationHost>>;

export async function rowsWhere(
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

export const startedRuns = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.started' ? [event] : []));
const bindingUpdates = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'workspace.binding.updated' ? [event] : []));
export const moves = (rows: readonly HostLogRow[]) =>
  bindingUpdates(rows).filter((event) => event.enteredBy !== undefined);
export const sharedNotes = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'checkout.shared' ? [event] : []));
export const outputOf = (rows: readonly HostLogRow[], toolCallId: string) =>
  rows.flatMap(({ event }) =>
    event.type === 'effect.finished' && event.toolCallId === toolCallId ? [event.output] : []
  )[0];

/** Thread A has edited the shared checkout and its run is still in progress. */
export async function firstThreadIsWriting(hosted: Host): Promise<string> {
  const first = await hosted.thread();
  await hosted.run(first, 'A: write a.txt and keep working.');
  await hosted.startedWriting('a.txt');
  return first;
}

/** The thread's turn went on in a worktree: its first run ended and the host's next one finished. */
export async function turnFinishedAfter(
  hosted: Host,
  threadId: string,
  firstRunId: string
): Promise<readonly HostLogRow[]> {
  return await rowsWhere(hosted.core(), threadId, (all) => {
    const next = startedRuns(all).find((run) => run.parentMessageId === firstRunId);
    return next !== undefined && all.some(finished(next.runId));
  });
}
