/**
 * A Stop that lands while a run's end commits: the run entered a worktree, so
 * its end would carry the task on there. The Stop joins that run, so a run
 * its end started would queue behind the Stop itself and every thread's
 * commands would hang. A stopped run starts nothing after it.
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
import type { HostPlatform } from '../src/ports.js';
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

test('a Stop while a worktree-entering run ends returns and starts no continuation', async () => {
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
  // Hold the first run.finished commit: the run is mid-end when Stop arrives.
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let held = false;
  const writer = crashableStorePort(store, async (items: readonly AppendItem[]) => {
    if (!held && items.some((item) => item.event.type === 'run.finished')) {
      held = true;
      reached.resolve();
      await gate.promise;
    }
  });
  const core = await HostCore.open(writer.port, platform, () => () => undefined);
  cleanup.push(async () => {
    gate.resolve();
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
