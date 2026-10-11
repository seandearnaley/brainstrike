import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { runIndexerProcess } from '@brainstrike/indexer/host';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { openHostStateIndex } from '../src/host-state-index.js';
import { createProductionHostPlatform } from '../src/production-platform.js';
import { startAgentHost } from '../src/runtime.js';

const held = vi.hoisted(() => ({
  closeSent: false,
  ready: Promise.withResolvers<void>(),
  release: undefined as (() => void) | undefined,
  suffix: '',
  workers: [] as Worker[],
}));

vi.mock('node:worker_threads', async (load) => {
  const original = await load<typeof import('node:worker_threads')>();
  return {
    ...original,
    Worker: class extends original.Worker {
      private readonly hold: boolean;
      constructor(filename: string | URL, options?: WorkerOptions) {
        super(filename, options);
        this.hold = filename.toString().endsWith(held.suffix);
        if (this.hold) {
          held.workers.push(this);
        }
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const frame = args[0];
        // Hold the actual worker payload, not a fabricated readiness fixture.
        if (
          this.hold &&
          event === 'message' &&
          frame !== null &&
          typeof frame === 'object' &&
          'kind' in frame &&
          frame.kind === 'ready'
        ) {
          held.release = () => super.emit(event, ...args);
          held.ready.resolve();
          return true;
        }
        return super.emit(event, ...args);
      }
      override postMessage(...args: Parameters<Worker['postMessage']>): void {
        const frame: unknown = args[0];
        if (
          this.hold &&
          frame !== null &&
          typeof frame === 'object' &&
          'op' in frame &&
          frame.op === 'close'
        ) {
          held.closeSent = true;
        }
        super.postMessage(...args);
      }
    },
  };
});

afterEach(async () => {
  held.release?.();
  await Promise.all(held.workers.splice(0).map((worker) => worker.terminate()));
  held.release = undefined;
  held.ready = Promise.withResolvers<void>();
  held.closeSent = false;
});

test('an already closed startup owner cannot create an index worker after inline release', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-index-closed-owner-')));
  held.suffix = 'host-state-index-worker.js';
  try {
    await expect(
      openHostStateIndex(root, [], {
        register: async (close) => {
          await close();
        },
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('Host resource owner is closing');
    expect(held.workers).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('Quit closes a real index whose readiness is pending before releasing the canonical Root', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-index-quit-')));
  held.suffix = 'host-state-index-worker.js';
  const controller = new AbortController();
  const reason = new Error('Recorded Quit while index readiness was pending');
  const starting = startAgentHost(
    { lifetime: 'persistent', root },
    async (startup) => {
      const result = await createProductionHostPlatform({
        configure: async () => ({
          close: async () => undefined,
          readConfiguration: async () => {
            throw new Error('No run admitted');
          },
          readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
          resolveProviderAuth: async () => undefined,
        }),
        memoryResourceIds: [],
        startup,
      });
      return result.platform;
    },
    controller.signal
  );
  const outcome = starting.catch((cause: unknown) => cause);
  try {
    await held.ready.promise;
    expect(RootLock.inspect(root)?.owner.released).not.toBe(true);
    controller.abort(reason);
    await vi.waitFor(() => expect(held.closeSent).toBe(true));
    expect(await outcome).toBe(reason);
    expect(held.workers.every((worker) => worker.threadId === -1)).toBe(true);
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    await (await StateStore.open(root)).close();
  } finally {
    controller.abort(reason);
    held.release?.();
    const result = await outcome;
    if (
      result &&
      typeof result === 'object' &&
      'close' in result &&
      typeof result.close === 'function'
    ) {
      await result.close();
    }
    await rm(root, { force: true, recursive: true });
  }
});

test('the index process receives Close while its real nested writer readiness is pending', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-index-inner-quit-')));
  held.suffix = 'writer-worker.js';
  let receive: ((message: unknown) => void) | undefined;
  const responses: object[] = [];
  const finished = Promise.withResolvers<void>();
  const running = runIndexerProcess(
    {
      dbPath: join(root, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      rootIds: [],
    },
    {
      finish: () => finished.resolve(),
      onMessage: (listener) => {
        receive = listener;
      },
      send: (message) => {
        responses.push(message);
      },
    }
  );
  try {
    await held.ready.promise;
    expect(receive).toBeDefined();
    receive?.({ id: 1, op: 'close', payload: null });
    await finished.promise;
    await running;
    expect(responses).toEqual([{ id: 1, kind: 'response', ok: true, value: true }]);
    expect(held.workers.every((worker) => worker.threadId === -1)).toBe(true);
  } finally {
    held.release?.();
    await Promise.all(held.workers.map((worker) => worker.terminate()));
    await running;
    await rm(root, { force: true, recursive: true });
  }
});
