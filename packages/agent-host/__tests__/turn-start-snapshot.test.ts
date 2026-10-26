/**
 * A run's turn-start snapshot brackets everything its tools change, but the
 * model never reads it: the first request goes out while the snapshot is
 * still being taken, and the run's first tool waits until it is recorded.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostRunAdmission } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import {
  crashableStorePort,
  finished,
  recordingAdmission,
  stream,
  text,
  toolCall,
} from './fixtures/child-run-host.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

const ROOT = { commitOid: 'a'.repeat(40), rootId: 'root-1', rootPath: '/workspace' };

test('the first request goes out before the turn-start snapshot is recorded, and no tool acts before it', async () => {
  const snapshotTaken = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  const touched: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      requested.resolve();
      const answered = call.prompt.some((message) => message.role === 'tool');
      return stream(answered ? text('Done.') : toolCall('touch', {}, 'touch-call'));
    },
  });
  const base: HostPlatform = {
    close: async () => undefined,
    maxSteps: 4,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => model,
    tools: {
      touch: {
        description: 'Change the workspace',
        execute: async () => {
          touched.push('touched');
          return { ok: true };
        },
        identity: 'touch-generation-1',
        inputSchema: z.object({}),
        risk: 'read',
      },
    },
  };
  const admit = recordingAdmission([])(base);
  const platform: HostPlatform = {
    ...base,
    admitRun: async (request): Promise<HostRunAdmission> => {
      const admission = await admit?.(request);
      if (!admission) {
        throw new Error('No admission');
      }
      return {
        ...admission,
        captureTurnBoundary: async ({ boundary }) => {
          if (boundary === 'turn-start') {
            await snapshotTaken.promise;
          }
          return [ROOT];
        },
      };
    },
  };
  const dir = await mkdtemp(join(tmpdir(), 'bs-turn-start-'));
  const store = await StateStore.open(dir);
  const core = await HostCore.open(crashableStorePort(store).port, platform, () => () => undefined);
  cleanup.push(async () => {
    // A run still waiting on its snapshot closes once the snapshot is taken.
    snapshotTaken.resolve();
    await core.close();
    await store.close();
    await rm(dir, { force: true, recursive: true });
  });
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  const { runId } = await core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Touch the workspace.',
    threadId,
  });

  // The model is asked while the snapshot is still being taken; the tool it calls waits.
  await expect(requested.promise).resolves.toBeUndefined();
  expect(touched).toEqual([]);
  snapshotTaken.resolve();

  let rows: readonly HostLogRow[] = [];
  await expect
    .poll(
      async () => {
        rows = await core.read(threadId, 0);
        return rows.some(finished(runId));
      },
      { timeout: 15_000 }
    )
    .toBe(true);
  expect(touched).toEqual(['touched']);
  const order = rows.flatMap(({ event }) =>
    event.type === 'workspace.snapshot.recorded'
      ? [`snapshot:${event.boundary}`]
      : event.type === 'effect.started' || event.type === 'run.finished'
        ? [event.type]
        : []
  );
  expect(order).toEqual([
    'snapshot:turn-start',
    'effect.started',
    'snapshot:turn-end',
    'run.finished',
  ]);
  expect(rows.find(finished(runId))?.event).toMatchObject({ outcome: 'completed' });
});
