import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { HostCore } from '../src/core.js';
import type { HostPlatform, HostRunContext, HostRunOwner } from '../src/ports.js';
import { HostRunOwnerCleanupError } from '../src/run-admission.js';
import { scriptedModel } from './fixtures/scripted-model.js';

function platform(openRun: (context: HostRunContext) => Promise<HostRunOwner>): HostPlatform {
  return {
    close: async () => undefined,
    maxSteps: 3,
    openRun,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => scriptedModel(),
    tools: {},
  };
}

async function withCore(
  openRun: (context: HostRunContext) => Promise<HostRunOwner>,
  work: (core: HostCore, threadId: string) => Promise<void>
): Promise<void> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-m3-run-owner-cleanup-'));
  const store = await StateStore.open(dataRoot);
  const core = await HostCore.open(store, platform(openRun), () => () => undefined);
  try {
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    await work(core, threadId);
  } finally {
    await core.close().catch(() => undefined);
    await store.close();
    await rm(dataRoot, { force: true, recursive: true });
  }
}

test('closing the host while a run owner is still opening is not a cleanup failure', async () => {
  const opening = Promise.withResolvers<void>();
  await withCore(
    // The open acquires nothing before its gate, and the gate is the host's
    // own abort: close is the only thing that settles it.
    async (context) => {
      opening.resolve();
      return await new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), {
          once: true,
        });
      });
    },
    async (core, threadId) => {
      await core.startRun({
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Report completion.',
        threadId,
      });
      await opening.promise;
      await expect(core.close()).resolves.toBeUndefined();
      const finished = (await core.read(threadId, 0)).find(
        (row) => row.event.type === 'run.finished'
      )?.event;
      expect(finished).toMatchObject({ outcome: 'interrupted', type: 'run.finished' });
    }
  );
});

/** Every error in an AggregateError tree. */
function flatten(error: unknown): unknown[] {
  return error instanceof AggregateError ? [error, ...error.errors.flatMap(flatten)] : [error];
}

test('an owner open that cannot join what it acquired still fails host cleanup', async () => {
  const leak = new HostRunOwnerCleanupError(
    new Error('Recorded owner construction failure'),
    new Error('Recorded owner join failure')
  );
  const attempted = Promise.withResolvers<void>();
  await withCore(
    async () => {
      attempted.resolve();
      throw leak;
    },
    async (core, threadId) => {
      await core.startRun({
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Report completion.',
        threadId,
      });
      await attempted.promise;
      // The unjoined acquisition keeps the run owned: it never commits a
      // terminal row, and closing the host reports the leak.
      const [closed] = await Promise.allSettled([core.close()]);
      expect(closed?.status).toBe('rejected');
      expect(closed?.status === 'rejected' ? flatten(closed.reason) : []).toContain(leak);
    }
  );
});
