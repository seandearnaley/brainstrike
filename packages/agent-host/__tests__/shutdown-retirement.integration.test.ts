import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import { expect, onTestFinished, test } from 'vitest';
import { startAgentHost } from '../src/runtime.js';
import { scriptedModel } from './fixtures/scripted-model.js';

function errorMembers(cause: unknown): readonly unknown[] {
  return cause instanceof AggregateError
    ? [cause, ...cause.errors.flatMap((member: unknown) => errorMembers(member))]
    : [cause];
}

type Mode = 'held' | 'owner' | 'platform' | 'writer';

async function interruptedHost(mode: Mode) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-retirement-')));
  const checkpointEntered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const ownerEntered = Promise.withResolvers<void>();
  const ownerRelease = Promise.withResolvers<void>();
  const platformEntered = Promise.withResolvers<void>();
  const platformRelease = Promise.withResolvers<void>();
  const independent = new Error('Synthetic independent retirement rejection');
  let signal: AbortSignal | undefined;
  let store: StateStore | undefined;
  let writer: Worker | undefined;
  let writerExit: number | undefined;
  let closeStore: (() => Promise<void>) | undefined;
  let terminateWriter: (() => Promise<number>) | undefined;
  let storeCloses = 0;
  let ownerCloses = 0;
  let platformCloses = 0;
  const host = await startAgentHost({ lifetime: 'persistent', root }, async (startup) => {
    store = startup.store;
    const acquired: unknown = Object.getOwnPropertyDescriptor(store, 'worker')?.value;
    if (!(acquired instanceof Worker)) {
      throw new Error('Actual canonical writer was not acquired');
    }
    writer = acquired;
    terminateWriter = writer.terminate.bind(writer);
    if (mode === 'writer') {
      writer.terminate = async () => {
        throw independent;
      };
    }
    writer.once('exit', (code) => {
      writerExit = code;
    });
    closeStore = store.close.bind(store);
    store.close = async () => {
      storeCloses += 1;
      await closeStore?.();
    };
    return {
      close: async () => {
        platformCloses += 1;
        platformEntered.resolve();
        if (mode === 'held') {
          await platformRelease.promise;
        }
        if (mode === 'platform') {
          throw independent;
        }
      },
      maxSteps: 3,
      openRun: async (context) => {
        signal = context.signal;
        signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        return {
          close: async () => {
            ownerCloses += 1;
            ownerEntered.resolve();
            if (mode === 'held') {
              await ownerRelease.promise;
            }
            if (mode === 'owner') {
              // Same object as the checkpoint's cancellation, but this is an
              // opaque resource join rejection. Identity cannot prove retirement.
              throw context.signal.reason;
            }
          },
          commitHostStep: async () => {
            checkpointEntered.resolve();
            await aborted.promise;
            context.signal.throwIfAborted();
          },
        };
      },
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES },
        yolo: false,
      }),
      resolveModel: async () => scriptedModel(),
      tools: {},
    };
  });
  onTestFinished(async () => {
    ownerRelease.resolve();
    platformRelease.resolve();
    await host.close().catch(() => undefined);
    // These synthetic rejecting ports own no native resources. Their fixture
    // owner explicitly joins its real writer after assertions about retention.
    if (mode === 'writer') {
      await terminateWriter?.();
      store?.lock.release();
    } else {
      await closeStore?.();
    }
    expect(writer?.threadId).toBe(-1);
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    await rm(root, { force: true, recursive: true });
  });
  const { threadId } = await host.core.startThread({ commandId: randomUUID() });
  const { runId } = await host.core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Report completion.',
    threadId,
  });
  await checkpointEntered.promise;
  return {
    host,
    independent,
    ownerEntered: ownerEntered.promise,
    ownerRelease,
    platformEntered: platformEntered.promise,
    platformRelease,
    root,
    runId,
    state: () => ({ ownerCloses, platformCloses, signal, store, storeCloses, writer, writerExit }),
    threadId,
  };
}

test('checkpoint outcome waits every owner before joining the actual writer and releases Root while reporting the original failure', async () => {
  const f = await interruptedHost('held');
  let settled = false;
  const closing = f.host.close().catch((cause: unknown) => {
    settled = true;
    return cause;
  });
  await f.ownerEntered;
  expect(settled).toBe(false);
  expect(f.state().storeCloses).toBe(0);
  expect(f.state().writer?.threadId).toBeGreaterThan(0);
  await expect(StateStore.open(f.root)).rejects.toBeInstanceOf(RootLockedError);
  f.ownerRelease.resolve();
  await f.platformEntered;
  expect(settled).toBe(false);
  expect(f.state().storeCloses).toBe(0);
  await expect(StateStore.open(f.root)).rejects.toBeInstanceOf(RootLockedError);
  f.platformRelease.resolve();
  const failure = await closing;
  expect(errorMembers(failure)).toContain(f.state().signal?.reason);
  expect(f.state()).toMatchObject({ ownerCloses: 1, platformCloses: 1, storeCloses: 1 });
  expect(f.state().writer?.threadId).toBe(-1);
  expect(f.state().writerExit).toBeTypeOf('number');
  expect(RootLock.inspect(f.root)?.owner.released).toBe(true);
  await expect(f.host.close()).rejects.toBe(failure);
  expect(f.state().storeCloses).toBe(1);
  const reopened = await StateStore.open(f.root);
  await reopened.close();
});

test.each(['owner', 'platform', 'writer'] as const)(
  'a rejected %s join keeps the actual writer and Root owned and preserves independent causes',
  async (mode) => {
    const f = await interruptedHost(mode);
    const failure = await f.host.close().catch((cause: unknown) => cause);
    const members = errorMembers(failure);
    expect(members).toContain(f.state().signal?.reason);
    if (mode !== 'owner') {
      expect(members).toContain(f.independent);
    }
    expect(f.state().writer?.threadId).toBeGreaterThan(0);
    expect(f.state().writerExit).toBeUndefined();
    expect(f.state().storeCloses).toBe(mode === 'writer' ? 1 : 0);
    expect(RootLock.inspect(f.root)?.owner.released).not.toBe(true);
    await expect(StateStore.open(f.root)).rejects.toBeInstanceOf(RootLockedError);
    await expect(f.host.close()).rejects.toBe(failure);
    expect(f.state()).toMatchObject({ ownerCloses: 1, platformCloses: 1 });
  }
);
