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
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostRunAdmissionRequest } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import {
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

async function host(model: MockLanguageModelV4, offered: string[], risk: 'edit' | 'read' = 'read') {
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
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'ask' },
      yolo: false,
    }),
    resolveModel: async () => model,
    tools: {
      create_worktree: {
        description: 'Create a worktree and work in it',
        execute: async (_input, context) => {
          offered.push(context.enterWorktree ? 'offered' : 'absent');
          await context.enterWorktree?.(WORKTREE);
          return { path: WORKTREE.root.path };
        },
        identity: 'create-worktree-generation-1',
        inputSchema: z.object({}),
        risk,
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
      return rootId
        ? {
            ...admission,
            configuration: { ...admission.configuration, boundWorkspaceRootId: rootId },
          }
        : admission;
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
  expect(next).toMatchObject({ parentMessageId: first });
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
