import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import recording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import { expect, test } from 'vitest';
import { z } from 'zod';
import { storedHostEvent } from '../src/event-storage.js';
import type { HostPlatform } from '../src/ports.js';
import { HostLogRowSchema } from '../src/protocol.js';
import { AgentHostStartupError, startAgentHost } from '../src/runtime.js';

type NativeIndexer = Awaited<ReturnType<typeof openIndexer>>;
const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };

function openNative(root: string): Promise<NativeIndexer> {
  return openIndexer(
    {
      dbPath: join(root, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      rootIds: [root],
      stateProjection: {
        mode: 'dev',
        module: new URL('../dist/state-projection.js', import.meta.url).href,
      },
      stateRoot: root,
    },
    deadlines
  );
}

function platform(close: () => Promise<void>): HostPlatform {
  return {
    close,
    maxSteps: 1,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => {
      throw new Error('Startup replay must not invoke inference');
    },
    tools: {},
  };
}

/** Recorded Core payload; fail after canonical deletion, leaving its real replay intent. */
async function interruptedDelete(root: string): Promise<{ threadId: string; remaining: unknown }> {
  const native = await openNative(root);
  const indexed = createStateStoreIndexer(native);
  const failure = new Error('Recorded native deletion interruption');
  const store = await StateStore.open(root, {
    indexer: { ...indexed, dropThread: async () => Promise.reject(failure) },
  });
  try {
    const captured = z.array(HostLogRowSchema).parse(recording);
    const threadId = captured[0]?.threadId;
    if (!threadId) {
      throw new Error('Core recording has no thread');
    }
    await store.append(captured.map((row) => storedHostEvent(row.threadId, row.event)));
    await native.catchUpState(await store.threads());
    await expect(store.deleteThread(threadId)).rejects.toBe(failure);
    expect((await native.stateStats(threadId)).docs).toBeGreaterThan(0);
    return { remaining: await store.readAll(), threadId };
  } finally {
    await native.close();
    await store.close();
  }
}

test('Core acquires its borrowed native indexer under Root before replaying an interrupted deletion', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-core-startup-indexer-')));
  let native: NativeIndexer | undefined;
  let acquiredStore: StateStore | undefined;
  let host: Awaited<ReturnType<typeof startAgentHost>> | undefined;
  try {
    const { remaining, threadId } = await interruptedDelete(root);
    host = await startAgentHost({ lifetime: 'persistent', root }, async (context) => {
      acquiredStore = context.store;
      await expect(RootLock.acquire(root)).rejects.toBeInstanceOf(RootLockedError);
      await context.register(async () => native?.close());
      native = await openNative(root);
      return {
        ...platform(async () => native?.close()),
        stateIndexer: createStateStoreIndexer(native),
      };
    });
    expect(host.core.store).toBe(acquiredStore);
    expect(host.core.listThreads()).not.toContainEqual({ threadId });
    expect(await acquiredStore?.readAll()).toEqual(remaining);
    expect(await native?.stateStats(threadId)).toMatchObject({ docs: 0, gaps: [] });
    expect(await native?.stateHealth()).toEqual({ indexerErrors: [] });
    await host.close();
    host = undefined;
    const lock = await RootLock.acquire(root);
    lock.release();
  } finally {
    await host?.close();
    await native?.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('failed replay joins the original native owner before releasing Root or publishing a host', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-core-replay-join-')));
  const replayFailure = new Error('Recorded replay deletion failure');
  const failedReplay = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  let native: NativeIndexer | undefined;
  let settled = false;
  let startup: Promise<unknown> | undefined;
  try {
    await interruptedDelete(root);
    startup = startAgentHost({ lifetime: 'persistent', root }, async (context) => {
      await context.register(async () => {
        await releaseClose.promise;
        await native?.close();
      });
      native = await openNative(root);
      const indexed = createStateStoreIndexer(native);
      return {
        ...platform(async () => undefined),
        stateIndexer: {
          ...indexed,
          dropThread: async () => {
            failedReplay.resolve();
            throw replayFailure;
          },
        },
      };
    });
    startup.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.race([
      failedReplay.promise,
      startup.then(
        () => {
          throw new Error('Startup completed before its replay failure');
        },
        (cause: unknown) => {
          throw cause;
        }
      ),
    ]);
    await expect(RootLock.acquire(root)).rejects.toBeInstanceOf(RootLockedError);
    expect(settled).toBe(false);
    expect(await native?.info()).toHaveProperty('storeId');
    await expect(stat(join(root, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    releaseClose.resolve();
    await expect(startup).rejects.toBe(replayFailure);
    const lock = await RootLock.acquire(root);
    lock.release();
  } finally {
    releaseClose.resolve();
    await startup?.catch(() => undefined);
    await native?.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('unproved native cleanup after failed replay retains the same canonical writer and Root', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-core-replay-retained-')));
  const replayFailure = new Error('Recorded replay deletion failure');
  const cleanupFailure = new Error('Recorded unjoined native owner');
  let native: NativeIndexer | undefined;
  let acquiredStore: StateStore | undefined;
  try {
    await interruptedDelete(root);
    const startup = startAgentHost({ lifetime: 'persistent', root }, async (context) => {
      acquiredStore = context.store;
      await context.register(async () => {
        throw cleanupFailure;
      });
      native = await openNative(root);
      return {
        ...platform(async () => undefined),
        stateIndexer: {
          ...createStateStoreIndexer(native),
          dropThread: async () => {
            throw replayFailure;
          },
        },
      };
    });
    const cause: unknown = await startup.catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(AgentHostStartupError);
    if (!(cause instanceof AgentHostStartupError)) {
      throw new Error('Startup did not retain its writer owner');
    }
    expect(cause.store).toBe(acquiredStore);
    expect(cause.store.lock.isReleased).toBe(false);
    expect(await native?.info()).toHaveProperty('storeId');
    await expect(RootLock.acquire(root)).rejects.toBeInstanceOf(RootLockedError);
    await expect(stat(join(root, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    // Fixture teardown proves native exit before releasing the deliberately retained writer.
    await native?.close();
    await acquiredStore?.close();
    await rm(root, { force: true, recursive: true });
  }
});
