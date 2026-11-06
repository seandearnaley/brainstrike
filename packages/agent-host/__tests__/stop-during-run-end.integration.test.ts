/**
 * A Stop that lands while a run's end commits: the run entered a worktree, so
 * its end would carry the task on there. The Stop joins that run, so a run
 * its end started would queue behind the Stop itself and every thread's
 * commands would hang. A stopped run starts nothing after it, and neither
 * does a turn stopped while its continuation waited to start.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
} from '@brainstrike/assistant-contract';
import { type AppendItem, StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostRunOwner } from '../src/ports.js';
import {
  crashableStorePort,
  recordingAdmission,
  stream,
  text,
  toolCall,
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
  branch: 'fix/stop',
  localRootId: 'local-root',
  root: { displayName: 'stop', path: '/worktrees/stop', rootId: 'worktree-root' },
  worktreeId: 'worktree-1',
};

/** A thread whose first run enters a worktree, so its end carries the task on there. */
async function worktreeHost(
  options: {
    /** Holds a batch's commit until it resolves. */
    readonly hold?: (items: readonly AppendItem[]) => Promise<void>;
    readonly openRun?: HostPlatform['openRun'];
  } = {}
) {
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      if (userTexts(call).some((input) => input.includes(WORKTREE.root.path))) {
        return stream(text('Continuing in the worktree.'));
      }
      return stream(toolCall('create_worktree', {}, 'wt-call'));
    },
  });
  const root = await mkdtemp(join(tmpdir(), 'bs-stop-run-end-'));
  const store = await StateStore.open(root);
  const base: HostPlatform = {
    close: async () => undefined,
    delegation: { personas: [worker], settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS } },
    maxSteps: 4,
    ...(options.openRun ? { openRun: options.openRun } : {}),
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => model,
    tools: {
      create_worktree: {
        description: 'Create a worktree and work in it',
        execute: async (_input, context) => {
          await context.enterWorktree?.(WORKTREE);
          return { path: WORKTREE.root.path };
        },
        identity: 'create-worktree-generation-1',
        inputSchema: z.object({}),
        risk: 'read',
      },
    },
    validateWorkspaceBinding: async () => undefined,
  };
  const recorded = recordingAdmission([])(base);
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
  const writer = crashableStorePort(store, async (items) => {
    await options.hold?.(items);
  });
  const core = await HostCore.open(writer.port, platform, () => () => undefined);
  const release = Promise.withResolvers<void>();
  cleanup.push(async () => {
    release.resolve();
    await core.close();
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
  const { runId } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Fix it.',
    threadId,
  });
  return { core, runId, threadId };
}

test('a Stop while a worktree-entering run ends returns and starts no continuation', async () => {
  // Hold the first run.finished commit: the run is mid-end when Stop arrives.
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let held = false;
  cleanup.push(async () => gate.resolve());
  const { core, runId, threadId } = await worktreeHost({
    hold: async (items) => {
      if (!held && items.some((item) => item.event.type === 'run.finished')) {
        held = true;
        reached.resolve();
        await gate.promise;
      }
    },
  });
  await reached.promise;
  const stop = core.stop({ commandId: randomUUID(), runId, threadId });
  // The Stop's intent commits while the run's own end is still held.
  await expect
    .poll(async () =>
      (await core.read(threadId, 0)).some(
        ({ event }) => event.type === 'command.accepted' && event.method === 'run/stop'
      )
    )
    .toBe(true);
  gate.resolve();
  await expect(stop).resolves.toEqual({ outcome: 'stopped' });
  // Another thread's command is admitted: the shared admission queue drained.
  await expect(core.startThread({ commandId: randomUUID() })).resolves.toMatchObject({
    threadId: expect.any(String),
  });
  const rows = await core.read(threadId, 0);
  expect(rows.filter(({ event }) => event.type === 'run.started')).toHaveLength(1);
});

test('a turn stopped while its continuation waits to start starts no continuation', async () => {
  // As the run's memory settles, another thread's command holds the admission
  // queue and the composer's Stop of the turn queues behind it. The run's end
  // decides to continue before that Stop is admitted.
  const ready = Promise.withResolvers<{ core: HostCore; runId: string; threadId: string }>();
  const settled = Promise.withResolvers<void>();
  const holding = Promise.withResolvers<void>();
  cleanup.push(async () => holding.resolve());
  let holdNextThread = false;
  let stop: Promise<{ outcome: string }> | undefined;
  let other: Promise<unknown> | undefined;
  let opened = 0;
  const host = await worktreeHost({
    hold: async (items) => {
      if (holdNextThread && items.some((item) => item.event.type === 'thread.started')) {
        holdNextThread = false;
        await holding.promise;
      }
    },
    openRun: async (): Promise<HostRunOwner> => {
      const first = opened++ === 0;
      return {
        close: async () => {
          if (!first) {
            return;
          }
          const { core, runId, threadId } = await ready.promise;
          holdNextThread = true;
          other = core.startThread({ commandId: randomUUID() });
          stop = core.stop({ commandId: randomUUID(), runId, threadId });
          settled.resolve();
        },
        endTurn: async () => undefined,
      };
    },
  });
  ready.resolve(host);
  await settled.promise;
  // One read later the run's end has decided what follows it.
  await host.core.read(host.threadId, 0);
  holding.resolve();

  await expect(stop).resolves.toEqual({ outcome: 'already-terminal' });
  await other;
  await host.core.idle(host.threadId);
  const rows = await host.core.read(host.threadId, 0);
  expect(rows.filter(({ event }) => event.type === 'run.started')).toHaveLength(1);
  expect(
    rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : []))
  ).toEqual(['completed']);
});
