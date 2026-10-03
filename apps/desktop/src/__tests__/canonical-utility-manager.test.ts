// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import { CANONICAL_CHANNEL, decodeCanonicalFrame } from '../canonical-utility-protocol';
import { IndexerHostManager } from '../indexer-host-manager';

const engine = vi.hoisted(() => ({ close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) }));
let child: EventEmitter & { postMessage: (message: unknown) => void; kill: () => boolean };
let heldScan: (() => void) | undefined;
let owner = '';
const file = {
  embeddingSetId: 'set',
  fileId: 'file',
  fileName: 'x.ts',
  relativePath: null,
  rootId: null,
  sourcePath: null,
};
const scope = { embeddingSetId: 'set', kind: 'collection' as const };

vi.mock('electron', () => ({
  app: { isReady: () => true },
  utilityProcess: { fork: () => child },
}));
vi.mock('@brainstrike/indexer/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/indexer/transport')>();
  return {
    ...actual,
    createIndexerConnection: (
      _options: unknown,
      _deadlines: unknown,
      transport: {
        onMessage: (listener: (frame: unknown) => void) => unknown;
        onExit: (listener: () => void) => unknown;
        onError: (listener: (error: unknown) => void) => unknown;
      }
    ) => {
      transport.onMessage(() => {});
      transport.onExit(() => {});
      transport.onError(() => {});
      return {
        close: engine.close,
        destroy: engine.destroy,
        exited: false,
        ready: Promise.resolve(engine),
      };
    },
  };
});

function dependencies(read: () => Promise<void>): CanonicalCollectionDependencies {
  return {
    catalog: {
      applyManagedCacheBatch: async () => {},
      completeFiles: async () => {},
      loadAuthorizedBatch: async () => [],
      prepareManagedSourcesBatch: async () => [],
      removeFiles: async () => {},
      resolveProfile: async () => {
        throw new Error('TEXT profile resolved');
      },
    },
    parser: { parser: 'oxc', treeSitterLanguages: [] },
    publication: {
      abortScan: async () => {},
      beginScan: async ({ requestId }) => ({ generation: 1, requestId, scope, storeId: 'store' }),
      commitTextFile: async () => {},
      finishScan: async ({ ticket }) => ({ reason: 'complete', scanComplete: true, ticket }),
      removeFile: async () => {},
      verifyManifest: async () => ({
        changed: [],
        complete: true,
        missing: [],
        storeId: 'store',
        unexpected: [],
      }),
    },
    request: { batchSize: 1, chunkingOptions: { strategy: 'recursive' }, maxFileBytes: 1024 },
    scope,
    source: {
      indexingPolicyPreset: 'balanced',
      inventory: {
        loadFiles: async () => [
          { ...file, chunksProcessed: false, contentHash: null, stat: { mtimeMs: null, size: 0 } },
        ],
        readRetained: async () => {
          await read();
          return { content: '', stat: { mtimeMs: null, size: 0 } };
        },
      },
    },
  };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  heldScan = undefined;
});

it('bounds returned scans, stops canonical admission on timeout and joins admitted main IO before engine close', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  child = Object.assign(new EventEmitter(), {
    kill: () => true,
    postMessage: (input: unknown): void => {
      const frame = decodeCanonicalFrame(input);
      if (frame.kind !== 'call') {
        return;
      }
      owner = frame.owner;
      const respond = (): void => {
        child.emit('message', {
          channel: CANONICAL_CHANNEL,
          id: frame.id,
          kind: 'result',
          ok: true,
          owner,
          value: null,
        });
      };
      if (frame.op === 'scan') {
        heldScan = respond;
      } else {
        queueMicrotask(respond);
      }
    },
  });
  const manager = await IndexerHostManager.create(
    {
      dbPath: '/explicit/derived.sqlite',
      embedding: { indexMode: 'text-only' },
      fileBindings: [],
      rootIds: [],
      scopes: [scope],
    },
    { closeMs: 100, exitMs: 100, requestMs: 20, startupMs: 100 },
    '/explicit/entry.js'
  );
  const read = vi.fn(() => held);
  const attachment = await manager.attachCanonicalCollection(dependencies(read));
  const call = (id: number, op: string, payload: unknown): void => {
    child.emit('message', {
      channel: CANONICAL_CHANNEL,
      id,
      kind: 'call',
      op,
      owner,
      payload,
      requestId: 'scan',
    });
  };
  call(10, 'load-files', scope);
  await flush();
  call(11, 'read-retained', {
    file: { ...file, stat: { mtimeMs: null, size: 0 } },
    maxFileBytes: 10,
  });
  await flush();
  expect(read).toHaveBeenCalledOnce();
  const scan = attachment.scan('scan');
  const timeout = expect(scan).rejects.toThrow(/owner remains retained/);
  await vi.advanceTimersByTimeAsync(21);
  await timeout;
  await expect(manager.start()).rejects.toThrow(/closed/);
  const close = manager.close();
  await flush();
  expect(engine.close).not.toHaveBeenCalled();
  release();
  expect(heldScan).toBeDefined();
  if (!heldScan) {
    throw new Error('Scan was never admitted.');
  }
  heldScan();
  await close;
  expect(engine.close).toHaveBeenCalledOnce();
});

it('retires canonical sources without closing the engine and permits a fresh source attachment', async () => {
  child = Object.assign(new EventEmitter(), {
    kill: () => true,
    postMessage: (input: unknown): void => {
      const frame = decodeCanonicalFrame(input);
      if (frame.kind !== 'call') {
        return;
      }
      queueMicrotask(() =>
        child.emit('message', {
          channel: CANONICAL_CHANNEL,
          id: frame.id,
          kind: 'result',
          ok: true,
          owner: frame.owner,
          value: null,
        })
      );
    },
  });
  const manager = await IndexerHostManager.create(
    {
      dbPath: '/explicit/derived.sqlite',
      embedding: { indexMode: 'text-only' },
      fileBindings: [],
      rootIds: [],
      scopes: [scope],
    },
    { closeMs: 100, exitMs: 100, requestMs: 100, startupMs: 100 },
    '/explicit/entry.js'
  );
  const original = await manager.start();
  await manager.attachCanonicalCollection(dependencies(async () => {}));
  await manager.retireCanonicalSources();
  expect(await manager.start()).toBe(original);
  expect(engine.close).not.toHaveBeenCalled();
  expect(engine.destroy).not.toHaveBeenCalled();
  await manager.attachCanonicalCollection(dependencies(async () => {}));
  await manager.close();
  expect(engine.close).toHaveBeenCalledOnce();
});
