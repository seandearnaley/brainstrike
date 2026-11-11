/**
 * ADR-0028 step 3: a worktree a root run creates becomes its thread's
 * workspace. The run ends after that step and the host starts the thread's
 * next run there, so every run keeps the one binding it was admitted with
 * (ADR-0017) and the person's own checkout is never the agent's.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostRunAdmissionRequest, HostToolContext } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import {
  blocked,
  type CallOptions,
  crashableStorePort,
  finished,
  recordingAdmission,
  stream,
  text,
  toolCall,
  toolNames,
  userTexts,
  worker,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const WORKTREE = {
  branch: 'fix/recapture-stop',
  localRootId: 'local-root',
  root: {
    displayName: 'recapture-stop',
    path: '/worktrees/recapture-stop',
    rootId: 'worktree-root',
  },
  worktreeId: 'worktree-1',
};
const CHILD_TASK = 'CHILD_TASK: make a worktree.';

async function host(
  model: MockLanguageModelV4,
  offered: string[],
  risk: 'edit' | 'read' = 'read',
  /** Auto access mode's quick model: an edit is reviewed by it instead of asking. */
  review?: LanguageModel,
  /** How the tool makes the worktree and enters it: at once, unless a test holds it. */
  enter: (context: HostToolContext) => Promise<void> = async (context) => {
    await context.enterWorktree?.(WORKTREE);
  }
) {
  const root = await mkdtemp(join(tmpdir(), 'bs-worktree-binding-'));
  const store = await StateStore.open(root);
  const requests: HostRunAdmissionRequest[] = [];
  const base: HostPlatform = {
    close: async () => undefined,
    delegation: {
      personas: [worker],
      settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS },
    },
    maxSteps: 4,
    readPermissionPolicy: () => ({
      ...(review ? { autoReview: { model: 'auto' } } : {}),
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask' },
      yolo: false,
    }),
    resolveModel: async () => model,
    tools: {
      create_worktree: {
        description: 'Create a worktree and work in it',
        execute: async (_input, context) => {
          offered.push(context.enterWorktree ? 'offered' : 'absent');
          await enter(context);
          return { path: WORKTREE.root.path };
        },
        identity: 'create-worktree-generation-1',
        inputSchema: z.object({}),
        risk,
      },
      write_file: {
        description: 'Write a workspace file',
        execute: async () => ({ written: true }),
        identity: 'native-write-generation-1',
        inputSchema: z.object({ path: z.string() }),
        risk: 'edit',
      },
    },
    validateWorkspaceBinding: async () => undefined,
  };
  // As the desktop admission does, the run's configuration names its bound root.
  const recorded = recordingAdmission(requests)(base);
  const platform: HostPlatform = {
    ...base,
    admitRun: async (request) => {
      const admission = await recorded?.(request);
      if (!admission) {
        throw new Error('No admission');
      }
      const rootId = request.workspaceBinding?.operatingRootId;
      return {
        ...admission,
        ...(rootId
          ? { configuration: { ...admission.configuration, boundWorkspaceRootId: rootId } }
          : {}),
        ...(review
          ? { reviewModel: async () => ({ model: review, modelId: 'openai::gpt-5.4-mini' }) }
          : {}),
      };
    },
  };
  let writer = crashableStorePort(store);
  let core = await HostCore.open(writer.port, platform, () => () => undefined);
  const crashed: HostCore[] = [];
  cleanup.push(async () => {
    await core.close();
    // A crashed Core can no longer commit its own teardown; only its joins matter here.
    await Promise.allSettled(crashed.map((dead) => dead.close()));
    await store.close();
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  await core.updateWorkspaceBinding({
    commandId: randomUUID(),
    patch: {
      operatingRootDisplayName: 'beaker',
      operatingRootId: 'local-root',
      operatingRootPath: '/repos/beaker',
    },
    threadId,
  });
  return {
    core,
    /** The process dies mid-run; a fresh Core recovers over the same committed store. */
    crash: async (): Promise<HostCore> => {
      writer.dead = true;
      crashed.push(core);
      writer = crashableStorePort(store);
      core = await HostCore.open(writer.port, platform, () => () => undefined);
      return core;
    },
    requests,
    store,
    threadId,
  };
}

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

const started = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.started' ? [event] : []));

async function rootEntersWorktree(risk: 'edit' | 'read'): Promise<void> {
  const offered: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (userTexts(call).some((input) => input.includes(WORKTREE.root.path))) {
        return stream(text('Continuing in the worktree.'));
      }
      const answered = call.prompt.some((message) => message.role === 'tool');
      return stream(
        answered ? text('Still in the old checkout.') : toolCall('create_worktree', {}, 'wt-call')
      );
    },
  });
  const { core, requests, threadId } = await host(model, offered, risk);
  const first = (
    await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Fix it.',
      threadId,
    })
  ).runId;

  if (risk === 'edit') {
    // A person approves the call; the approved call enters the worktree.
    const asked = await rowsWhere(core, threadId, (all) =>
      all.some(({ event }) => event.type === 'interaction.requested')
    );
    const request = asked.find(({ event }) => event.type === 'interaction.requested')?.event;
    if (request?.type !== 'interaction.requested') {
      throw new Error('Expected an approval request');
    }
    await core.respond({
      commandId: randomUUID(),
      decision: 'approve',
      interactionId: request.interactionId,
      runId: first,
      threadId,
    });
  }
  const rows = await rowsWhere(core, threadId, (all) => {
    const next = started(all).find((run) => run.runId !== first);
    return next !== undefined && all.some(finished(next.runId));
  });
  const [, next] = started(rows);

  // The binding moved through Core's own command path.
  const bindings = rows.flatMap(({ event }) =>
    event.type === 'workspace.binding.updated' ? [event.binding] : []
  );
  expect(bindings.at(-1)).toMatchObject({
    checkoutBranch: WORKTREE.branch,
    checkoutLocalRootId: 'local-root',
    checkoutMode: 'worktree',
    checkoutWorktreeId: WORKTREE.worktreeId,
    checkoutWorktreePath: WORKTREE.root.path,
    operatingRootId: WORKTREE.root.rootId,
    operatingRootPath: WORKTREE.root.path,
    secondaryRootIds: ['local-root'],
  });
  // The creating run ended after that step. An approved call resumes with
  // one model step, which is offered no tool, so nothing acts in the old
  // checkout; an allowed call ends with the step that made it.
  expect(rows.find(finished(first))?.event).toMatchObject({ outcome: 'completed' });
  if (risk === 'edit') {
    expect(model.doStreamCalls).toHaveLength(3);
    expect(toolNames(model.doStreamCalls[1] as CallOptions)).toEqual([]);
  } else {
    expect(model.doStreamCalls).toHaveLength(2);
  }
  // The host started the next run, after the first, admitted in the worktree.
  // It records that the host wrote its prompt, so no reader takes it for the person's words.
  expect(next).toMatchObject({ hostPrompt: true, parentMessageId: first });
  expect(rows.find(finished(next?.runId ?? ''))?.event).toMatchObject({ outcome: 'completed' });
  expect(requests.at(-1)?.workspaceBinding).toMatchObject({
    operatingRootId: WORKTREE.root.rootId,
  });
  expect(offered).toEqual(['offered']);
}

test('a root run that creates a worktree ends there, and the next run works in it', async () => {
  await rootEntersWorktree('read');
});

test('an approved worktree call ends its run there too, before any further step', async () => {
  await rootEntersWorktree('edit');
});

test("auto-review never reads the host's worktree continuation as the person's request", async () => {
  const reviews: string[] = [];
  const quick = new MockLanguageModelV4({
    doGenerate: async (options) => {
      reviews.push(JSON.stringify(options.prompt));
      const answer = {
        decision: 'approve',
        rationale: 'The user asked for the fix.',
        risk: 'low',
        userAuthorization: 'high',
      };
      return {
        content: [{ text: JSON.stringify(answer), type: 'text' }],
        finishReason: { raw: 'stop', unified: 'stop' },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
          outputTokens: { reasoning: 0, text: 1, total: 1 },
        },
        warnings: [],
      };
    },
  });
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const answered = call.prompt.at(-1)?.role === 'tool';
      if (userTexts(call).some((input) => input.includes(WORKTREE.root.path))) {
        return stream(
          answered ? text('Fixed.') : toolCall('write_file', { path: 'notes.md' }, 'write-1')
        );
      }
      return stream(answered ? text('Moved.') : toolCall('create_worktree', {}, 'wt-call'));
    },
  });
  const { core, threadId } = await host(model, [], 'read', quick);
  const first = (
    await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Fix it.',
      threadId,
    })
  ).runId;
  await rowsWhere(core, threadId, (all) => {
    const next = started(all).find((run) => run.runId !== first);
    return next !== undefined && all.some(finished(next.runId));
  });

  const [review] = reviews;
  expect(reviews).toHaveLength(1);
  expect(review).toContain('USER: Fix it.');
  expect(review).not.toContain('USER: Continue the task in the worktree');
});

test('a host restarted after an approved worktree entry ends that run there and continues in it', async () => {
  const offered: string[] = [];
  let restarted = false;
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (userTexts(call).some((input) => input.includes(WORKTREE.root.path))) {
        return stream(text('Continuing in the worktree.'));
      }
      if (!call.prompt.some((message) => message.role === 'tool')) {
        return stream(toolCall('create_worktree', {}, 'wt-call'));
      }
      if (!restarted) {
        // The process dies while the step after the entry is in flight.
        return await new Promise<never>((_resolve, reject) => {
          call.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return stream(text('Still in the old checkout.'));
    },
  });
  const { core, crash, requests, threadId } = await host(model, offered, 'edit');
  const first = (
    await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Fix it.',
      threadId,
    })
  ).runId;
  const asked = await rowsWhere(core, threadId, (all) =>
    all.some(({ event }) => event.type === 'interaction.requested')
  );
  const request = asked.find(({ event }) => event.type === 'interaction.requested')?.event;
  if (request?.type !== 'interaction.requested') {
    throw new Error('Expected an approval request');
  }
  await core.respond({
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: request.interactionId,
    runId: first,
    threadId,
  });
  await expect.poll(() => model.doStreamCalls.length, { timeout: 15_000 }).toBe(2);

  restarted = true;
  const recovered = await crash();
  const rows = await rowsWhere(recovered, threadId, (all) => {
    const next = started(all).find((run) => run.runId !== first);
    return next !== undefined && all.some(finished(next.runId));
  });

  // The recovered run kept the boundary: one tool-free step, then it ended.
  expect(toolNames(model.doStreamCalls[2] as CallOptions)).toEqual([]);
  expect(rows.find(finished(first))?.event).toMatchObject({ outcome: 'completed' });
  // Its continuation was started and admitted in the worktree.
  expect(started(rows).find((run) => run.runId !== first)).toMatchObject({
    parentMessageId: first,
  });
  expect(requests.at(-1)?.workspaceBinding).toMatchObject({
    operatingRootId: WORKTREE.root.rootId,
  });
  expect(offered).toEqual(['offered']);
});

type CallEnd = 'entered' | 'guard' | 'other' | 'run-aborted';

/**
 * The worktree tool's call, held while it makes the worktree: `git worktree
 * add` takes time and reads no signal. The test also plays the desktop's tool
 * guard, which answers a native call that outlives its budget (60 s by
 * default, `BRAINSTRIKE_TOOL_TIMEOUT_MS`). That guard is all that would end a
 * call whose entry waits on a command queued behind its own run's end.
 */
function heldWorktreeCall() {
  const making = Promise.withResolvers<void>();
  const made = Promise.withResolvers<void>();
  const guard = Promise.withResolvers<never>();
  guard.promise.catch(() => undefined);
  const ended = Promise.withResolvers<CallEnd>();
  const answered = new Error('The tool guard answered');
  const endOf = (cause: unknown, signal: AbortSignal): CallEnd => {
    if (cause === answered) {
      return 'guard';
    }
    return signal.aborted && cause === signal.reason ? 'run-aborted' : 'other';
  };
  return {
    /** What ended the call. */
    ended: ended.promise,
    enter: async ({ enterWorktree, signal }: HostToolContext): Promise<void> => {
      making.resolve();
      await made.promise;
      try {
        await Promise.race([enterWorktree?.(WORKTREE), guard.promise]);
        ended.resolve('entered');
      } catch (cause) {
        ended.resolve(endOf(cause, signal));
        throw cause;
      }
    },
    /** The guard answers, if nothing else has ended the call. */
    guard: (): void => guard.reject(answered),
    made: (): void => made.resolve(),
    /** Resolves once the call is making the worktree. */
    making: making.promise,
  };
}

const callsWorktreeTool = (): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doStream: async (call) =>
      stream(
        userTexts(call).some((input) => input.includes(WORKTREE.root.path))
          ? text('Continuing in the worktree.')
          : toolCall('create_worktree', {}, 'wt-call')
      ),
  });

test('a thread deleted while its worktree tool makes the worktree is deleted, and the host goes on', async () => {
  const call = heldWorktreeCall();
  const { core, threadId } = await host(callsWorktreeTool(), [], 'read', undefined, call.enter);
  await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Make a worktree.',
    threadId,
  });
  await call.making;

  // The deletion aborts the run and waits for it to end, while the call still makes the worktree.
  const deletion = core.deleteThread({ threadId });
  call.made();
  // The guard answers only once everything that waits on nothing else has settled.
  await nextTurn();
  call.guard();

  // The run's abort ended the call: its entry queued nothing behind the deletion.
  expect(await call.ended).toBe('run-aborted');
  await expect(deletion).resolves.toEqual({ deleted: true, threadIds: [threadId] });
  // Every other thread's commands, and the host's close, go through the same admission queue.
  await expect(core.startThread({ commandId: randomUUID() })).resolves.toEqual({
    threadId: expect.any(String),
  });
  await expect(core.close()).resolves.toBeUndefined();
});

test('a run stopped while its worktree tool makes the worktree leaves its thread where it was', async () => {
  const call = heldWorktreeCall();
  const { core, threadId } = await host(callsWorktreeTool(), [], 'read', undefined, call.enter);
  const run = (
    await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Make a worktree.',
      threadId,
    })
  ).runId;
  await call.making;

  const stopping = core.stop({ commandId: randomUUID(), runId: run, threadId });
  // The Stop is committed while the call still makes the worktree.
  await rowsWhere(core, threadId, (all) =>
    all.some(({ event }) => event.type === 'command.accepted' && event.method === 'run/stop')
  );
  call.made();

  await expect(stopping).resolves.toEqual({ outcome: 'stopped' });
  const rows = await rowsWhere(core, threadId, (all) => all.some(finished(run)));
  expect(rows.find(finished(run))?.event).toMatchObject({ outcome: 'stopped' });
  // Nobody asked for the worktree any more: the thread is not moved and no turn carries on there.
  expect(
    rows.filter(({ event }) => event.type === 'workspace.binding.updated' && event.enteredBy)
  ).toEqual([]);
  expect(core.readWorkspaceBinding(threadId).binding).toMatchObject({
    operatingRootId: 'local-root',
    operatingRootPath: '/repos/beaker',
  });
  expect(started(rows)).toHaveLength(1);
  // The call ends with the run's abort, as the run's other tools do.
  expect(await call.ended).toBe('run-aborted');
});

test('a delegated child is never offered a worktree to move its parent into', async () => {
  const offered: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const answered = call.prompt.some((message) => message.role === 'tool');
      if (userTexts(call).some((input) => input.includes(CHILD_TASK))) {
        return stream(
          answered ? text('Child done.') : toolCall('create_worktree', {}, 'child-call')
        );
      }
      if (!toolNames(call).includes('agent-worker') || answered) {
        return stream(text('Parent done.'));
      }
      return stream(
        toolCall(
          'agent-worker',
          { _background: { disposition: 'awaited', enabled: true }, prompt: CHILD_TASK },
          'delegate-1'
        )
      );
    },
  });
  const { core, store, threadId } = await host(model, offered);
  const first = (
    await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Delegate.',
      threadId,
    })
  ).runId;
  const rows = await rowsWhere(core, threadId, (all) => all.some(finished(first)));

  expect(offered).toEqual(['absent']);
  expect(
    rows.some(
      ({ event }) =>
        event.type === 'workspace.binding.updated' && event.binding.checkoutMode === 'worktree'
    )
  ).toBe(false);
  expect(started(rows)).toHaveLength(1);
  expect((await store.threads()).filter((id) => id !== threadId)).toHaveLength(1);
});

const BEFORE = 'BEFORE: work dispatched before the switch.';
const AFTER = 'AFTER: work dispatched in the worktree.';
const LEDGER = 'Background invocations of this turn';
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

/**
 * One request, as the debug pack of 4 Nov 2026 made it: the root dispatches a
 * worker, then asks to enter a worktree; the run the host continues there
 * dispatches another. A worker's context is its task alone.
 */
function fanOutAcrossWorktree(script: {
  /** Whether the root waits for its first worker's result before the switch. */
  readonly awaited?: boolean;
  readonly continued: (call: CallOptions) => Scripted;
  readonly worker: (task: string, call: CallOptions) => Promise<Scripted> | Scripted;
}): MockLanguageModelV4 {
  const before = {
    ...(script.awaited ? { _background: { disposition: 'awaited', enabled: true } } : {}),
    prompt: BEFORE,
  };
  return new MockLanguageModelV4({
    doStream: async (call) => {
      const task = [BEFORE, AFTER].find((candidate) => userTexts(call)[0]?.includes(candidate));
      if (task) {
        return await script.worker(task, call);
      }
      const turn = latestTurn(call);
      if (turn.text.includes(LEDGER)) {
        return stream(text('Noted.'));
      }
      if (turn.text.includes(WORKTREE.root.path)) {
        return turn.answered === 0
          ? stream(toolCall('agent-worker', { prompt: AFTER }, 'call-after'))
          : script.continued(call);
      }
      return stream(
        [
          toolCall('agent-worker', before, 'call-before'),
          toolCall('create_worktree', {}, 'wt-call'),
        ][turn.answered] ?? text('Waiting for the worker.')
      );
    },
  });
}

const wakeLedgers = (rows: readonly HostLogRow[]): string[] =>
  started(rows).flatMap((run) => (run.delivery?.via === 'wake' ? [run.prompt] : []));

test('a root is offered no worktree while a worker it dispatched still works, so the turn keeps one checkout', {
  timeout: 20_000,
}, async () => {
  const release = Promise.withResolvers<void>();
  const offered: string[] = [];
  const model = fanOutAcrossWorktree({
    continued: () => stream(text('Continuing in the worktree.')),
    worker: async (task) => {
      await release.promise;
      return stream(text(`${task.slice(0, 6)} report.`));
    },
  });
  const { core, threadId } = await host(model, offered);
  const turn = (
    await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Fan out.',
      threadId,
    })
  ).runId;
  await rowsWhere(core, threadId, (all) => all.some(finished(turn)));
  expect(offered).toEqual(['absent']);

  // The worker reports to the turn in the checkout both started in.
  release.resolve();
  const rows = await rowsWhere(core, threadId, (all) => wakeLedgers(all).length === 1);
  expect(wakeLedgers(rows)[0]).toContain(
    `${LEDGER} — 1 total: 1 returned, 0 failed, 0 cancelled, 0 still running.`
  );
  expect(
    rows.some(
      ({ event }) =>
        event.type === 'workspace.binding.updated' && event.binding.checkoutMode === 'worktree'
    )
  ).toBe(false);
});

test('a Stop of the run continued in a worktree stops its workers, in the turn the person started', {
  timeout: 20_000,
}, async () => {
  const model = fanOutAcrossWorktree({
    awaited: true,
    continued: (call) => blocked(call),
    worker: (task, call) => (task === BEFORE ? stream(text('BEFORE report.')) : blocked(call)),
  });
  const { core, crash, store, threadId } = await host(model, []);
  const turn = (
    await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Fan out.',
      threadId,
    })
  ).runId;
  // The root's two steps and its awaited worker's one, then the continuation's
  // two, its worker's call and the continuation's next step in flight.
  await expect.poll(() => model.doStreamCalls.length, { timeout: 15_000 }).toBe(6);
  const continued = started(await core.read(threadId, 0)).find((run) => run.runId !== turn);
  if (!continued) {
    throw new Error('Expected the run continued in the worktree');
  }

  await core.stop({ commandId: randomUUID(), runId: continued.runId, threadId });
  const children = (await store.threads()).filter((id) => id !== threadId);
  const outcomes = await Promise.all(
    children.map(async (child) =>
      (await core.read(child, 0)).flatMap(({ event }) =>
        event.type === 'run.finished' ? [event.outcome] : []
      )
    )
  );
  expect(outcomes.toSorted()).toEqual([['completed'], ['stopped']]);
  // The composer and the running-workers strip name one turn: the one the
  // person's message started, which the committed log keeps across a restart.
  const tree = core.trees.read(threadId);
  expect(tree.thread.run?.turnId).toBe(turn);
  expect(tree.descendants.map(({ origin }) => origin.turnId)).toEqual([turn, turn]);
  const recovered = await crash();
  expect(recovered.trees.read(threadId).thread.run?.turnId).toBe(turn);
});
