import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { RootLock, RootLockedError, StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, onTestFinished, test } from 'vitest';
import { startAgentHost } from '../src/runtime.js';

function errorMembers(cause: unknown): readonly unknown[] {
  return cause instanceof AggregateError
    ? [cause, ...cause.errors.flatMap((member: unknown) => errorMembers(member))]
    : [cause];
}

type Mode = 'platform' | 'writer';

async function interruptedHost(mode: Mode) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-retirement-')));
  const streaming = Promise.withResolvers<void>();
  const independent = new Error('Synthetic independent retirement rejection');
  // The run's provider stream is open until the host's close aborts it.
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      streaming.resolve();
      return await new Promise((_resolve, reject) => {
        abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      });
    },
  });
  let store: StateStore | undefined;
  let writer: Worker | undefined;
  let writerExit: number | undefined;
  let closeStore: (() => Promise<void>) | undefined;
  let terminateWriter: (() => Promise<number>) | undefined;
  let storeCloses = 0;
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
        if (mode === 'platform') {
          throw independent;
        }
      },
      maxSteps: 3,
      readPermissionPolicy: () => ({
        policies: { ...DEFAULT_PERMISSION_POLICIES },
        yolo: false,
      }),
      resolveModel: async () => model,
      tools: {},
    };
  });
  onTestFinished(async () => {
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
  await host.core.startRun({
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Report completion.',
    threadId,
  });
  await streaming.promise;
  return {
    host,
    independent,
    root,
    state: () => ({ platformCloses, store, storeCloses, writer, writerExit }),
  };
}

test.each(['platform', 'writer'] as const)(
  'a rejected %s join keeps the actual writer and Root owned and preserves independent causes',
  async (mode) => {
    const f = await interruptedHost(mode);
    const failure = await f.host.close().catch((cause: unknown) => cause);
    expect(errorMembers(failure)).toContain(f.independent);
    expect(f.state().writer?.threadId).toBeGreaterThan(0);
    expect(f.state().writerExit).toBeUndefined();
    expect(f.state().storeCloses).toBe(mode === 'writer' ? 1 : 0);
    expect(RootLock.inspect(f.root)?.owner.released).not.toBe(true);
    await expect(StateStore.open(f.root)).rejects.toBeInstanceOf(RootLockedError);
    await expect(f.host.close()).rejects.toBe(failure);
    expect(f.state()).toMatchObject({ platformCloses: 1 });
  }
);
