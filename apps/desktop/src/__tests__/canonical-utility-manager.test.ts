// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { CanonicalUtilityChild } from '../canonical-utility-child';
import type { CanonicalCollectionDependencies } from '../canonical-utility-parent';
import { CANONICAL_CHANNEL, decodeCanonicalFrame } from '../canonical-utility-protocol';
import { IndexerHostManager } from '../indexer-host-manager';
import { IndexerUtilityExitedError } from '../indexer-utility-exit';
import { NativeAuthorityTransitionError } from '../native-authority-transition';

const engine = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  exited: false,
}));
let child: EventEmitter & { postMessage: (message: unknown) => void; kill: () => boolean };
let heldScan: (() => void) | undefined;
let heldStart: (() => void) | undefined;
let heldCancel: (() => void) | undefined;
/** When set, the indexer connection becomes ready only when the test resolves it. */
let heldReady: Promise<unknown> | undefined;
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
        get exited() {
          return engine.exited;
        },
        ready: heldReady ?? Promise.resolve(engine),
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
    parser: { parser: 'oxc' },
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
  heldCancel = undefined;
  heldStart = undefined;
  heldReady = undefined;
  engine.exited = false;
});

// BST-2140 (Codex P1): the shutdown fence races an attachment still awaiting the host's start.
it.each(['workspace', 'collection'] as const)(
  'refuses a %s attachment the fence overtook in start, with the typed retirement and no session',
  async (kind) => {
    const frames: unknown[] = [];
    child = Object.assign(new EventEmitter(), {
      kill: () => true,
      postMessage: (input: unknown): void => {
        frames.push(input);
      },
    });
    const ready = Promise.withResolvers<unknown>();
    heldReady = ready.promise;
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
    const read = vi.fn(async () => {});
    const collection = dependencies(read);
    const acquiring = (
      kind === 'collection'
        ? manager.attachCanonicalCollection(collection)
        : manager.attachCanonicalWorkspace({
            ...collection,
            managedCollectionId: 'set',
            onError: vi.fn(),
            onReceipt: vi.fn(),
            onWatchHealth: vi.fn(),
            source: {
              indexingPolicyPreset: 'balanced',
              inventory: collection.source.inventory,
              lease: {
                canonicalPath: '/actual/root',
                generation: 'generation',
                listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
                readFile: vi.fn(async () => ({ status: 'not-found' as const })),
                retire: vi.fn(async () => {}),
                rootId: 'root',
                signal: new AbortController().signal,
                subscribe: vi.fn(async () => ({ close: async () => {} })),
              },
            },
          })
    ).catch((error: unknown) => error);
    await flush();
    manager.fenceCanonicalSources();
    ready.resolve(engine);
    expect(await acquiring).toBeInstanceOf(NativeAuthorityTransitionError);
    // No session: the utility never received an attach, so no callback or scan can start.
    expect(frames).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    await manager.close();
  }
);

it('bounds cancellation controls, stops admission on timeout and joins admitted scan and main IO before engine close', async () => {
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
          value:
            frame.op === 'join-scan'
              ? {
                  reason: 'aborted',
                  scanComplete: false,
                  ticket: { generation: 1, requestId: 'scan', scope, storeId: 'store' },
                }
              : null,
        });
      };
      if (frame.op === 'join-scan') {
        heldScan = respond;
      } else if (frame.op === 'cancel') {
        heldCancel = respond;
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
  const outcome = scan.catch((error: unknown) => error);
  const timeout = expect(attachment.cancel()).rejects.toThrow(/owner remains retained/);
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
  releaseScan();
  heldCancel?.();
  await outcome;
  await close;
  expect(engine.close).toHaveBeenCalledOnce();
});

function heldCollection(holdAdmission = false): {
  manager: Promise<IndexerHostManager>;
  calls: string[];
} {
  const calls: string[] = [];
  child = Object.assign(new EventEmitter(), {
    kill: () => true,
    postMessage: (input: unknown): void => {
      const frame = decodeCanonicalFrame(input);
      if (frame.kind !== 'call') {
        return;
      }
      owner = frame.owner;
      calls.push(frame.op);
      const respond = (): void => {
        child.emit('message', {
          channel: CANONICAL_CHANNEL,
          id: frame.id,
          kind: 'result',
          ok: true,
          owner: frame.owner,
          value:
            frame.op === 'join-scan'
              ? {
                  reason: 'complete',
                  scanComplete: true,
                  ticket: { generation: 1, requestId: 'scan', scope, storeId: 'store' },
                }
              : null,
        });
      };
      if (frame.op === 'join-scan') {
        heldScan = respond;
      } else if (frame.op === 'start-scan' && holdAdmission) {
        heldStart = respond;
      } else {
        queueMicrotask(respond);
      }
    },
  });
  return {
    calls,
    manager: IndexerHostManager.create(
      {
        dbPath: '/explicit/derived.sqlite',
        embedding: { indexMode: 'text-only' },
        fileBindings: [],
        rootIds: [],
        scopes: [scope],
      },
      { closeMs: 100, exitMs: 100, requestMs: 20, startupMs: 100 },
      '/explicit/entry.js'
    ),
  };
}

function releaseScan(): void {
  const release = heldScan;
  heldScan = undefined;
  release?.();
}

function releaseStart(): void {
  const release = heldStart;
  heldStart = undefined;
  release?.();
}

it('bounds missing child admission acknowledgement and fences subsequent work', async () => {
  vi.useFakeTimers();
  const fixture = heldCollection(true);
  const manager = await fixture.manager;
  const attachment = await manager.attachCanonicalCollection(dependencies(async () => {}));
  const scan = attachment.scan('scan');
  const result = scan.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(21);
  await expect(result).resolves.toMatchObject({
    message: expect.stringMatching(/owner remains retained/),
  });
  await expect(manager.start()).rejects.toThrow(/closed/);
  await expect(attachment.scan('late')).rejects.toThrow(/closed|admission/);
  expect(fixture.calls).not.toContain('join-scan');
  releaseStart();
  await flush();
  releaseScan();
  await manager.close();
});

it.each([false, true])(
  'reports a retained real child failure after an expired admission ACK before releasing the engine (close deadline expires: %s)',
  async (expireClose) => {
    vi.useFakeTimers();
    let startId: number | undefined;
    let finished!: () => void;
    const terminal = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const runtime = new CanonicalUtilityChild((input) => {
      const frame = decodeCanonicalFrame(input);
      const deliver = (): void => {
        child.emit('message', frame);
      };
      if (frame.kind === 'result' && frame.id === startId) {
        heldStart = deliver;
      } else {
        queueMicrotask(deliver);
      }
    });
    child = Object.assign(new EventEmitter(), {
      kill: () => true,
      postMessage: (input: unknown): void => {
        const frame = decodeCanonicalFrame(input);
        if (frame.kind === 'call' && frame.op === 'start-scan') {
          startId = frame.id;
        }
        queueMicrotask(() => runtime.receive(frame));
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
    const source = dependencies(async () => {});
    source.catalog.loadAuthorizedBatch = async ({ files }) =>
      files.map(() => ({
        ...file,
        chunksProcessed: false,
        contentHash: null,
        stat: { mtimeMs: null, size: 0 },
      }));
    source.publication.finishScan = async () => {
      finished();
      throw new Error('independent fast publication failure');
    };
    const attachment = await manager.attachCanonicalCollection(source);
    const result = attachment.scan('scan').catch((error: unknown) => error);
    try {
      await terminal;
      await flush();
      expect(heldStart).toBeDefined();
      await vi.advanceTimersByTimeAsync(21);
      await expect(result).resolves.toMatchObject({
        message: expect.stringMatching(/owner remains retained/),
      });
      await expect(attachment.scan('late')).rejects.toThrow(/admission is closed/);
      if (expireClose) {
        const close = manager.close().catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(101);
        await expect(close).resolves.toMatchObject({
          message: expect.stringMatching(/owner remains retained/),
        });
        expect(engine.close).not.toHaveBeenCalled();
      }
      releaseStart();
      await flush();
      await expect(manager.close()).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: 'independent fast publication failure' })],
      });
      expect(engine.close).not.toHaveBeenCalled();
    } finally {
      releaseStart();
      await flush();
      await manager.close();
      await runtime.close();
    }
    expect(engine.close).toHaveBeenCalledOnce();
  }
);

it('owns an admitted full scan beyond the control budget until the exact receipt arrives', async () => {
  vi.useFakeTimers();
  const fixture = heldCollection();
  const manager = await fixture.manager;
  const attachment = await manager.attachCanonicalCollection(dependencies(async () => {}));
  const scan = attachment.scan('scan');
  const outcomes: string[] = [];
  void scan.then(
    () => outcomes.push('receipt'),
    () => outcomes.push('error')
  );
  try {
    await vi.advanceTimersByTimeAsync(21);
    expect(outcomes).toEqual([]);
    expect(fixture.calls).toEqual(['attach', 'start-scan', 'join-scan']);
    await expect(manager.start()).resolves.toBeDefined();
    releaseScan();
    await expect(scan).resolves.toMatchObject({ reason: 'complete', scanComplete: true });
  } finally {
    releaseScan();
    await manager.close();
  }
});

it('keeps the engine owned after an early close acknowledgement until the scan terminal joins', async () => {
  const fixture = heldCollection();
  const manager = await fixture.manager;
  const attachment = await manager.attachCanonicalCollection(dependencies(async () => {}));
  const scan = attachment.scan('scan');
  const outcome = scan.catch((error: unknown) => error);
  await flush();
  const close = manager.close();
  try {
    await flush();
    expect(fixture.calls).toContain('close');
    expect(engine.close).not.toHaveBeenCalled();
    await expect(attachment.scan('late')).rejects.toThrow(/closed|admission/);
  } finally {
    releaseScan();
    await outcome;
    await close;
  }
  expect(engine.close).toHaveBeenCalledOnce();
});

it('fences scans at physical utility exit and rejects pending work only after admitted main IO joins', async () => {
  const fixture = heldCollection();
  const manager = await fixture.manager;
  let release!: () => void;
  const read = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  const attachment = await manager.attachCanonicalCollection(dependencies(read));
  for (const [id, op, payload] of [
    [10, 'load-files', scope],
    [
      11,
      'read-retained',
      { file: { ...file, stat: { mtimeMs: null, size: 0 } }, maxFileBytes: 10 },
    ],
  ] as const) {
    child.emit('message', {
      channel: CANONICAL_CHANNEL,
      id,
      kind: 'call',
      op,
      owner,
      payload,
      requestId: 'scan',
    });
    await flush();
  }
  expect(read).toHaveBeenCalledOnce();
  const scan = attachment.scan('scan');
  const result = scan.catch((error: unknown) => error);
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await flush();
  engine.exited = true;
  child.emit('exit');
  try {
    await flush();
    expect(settled).toBe(false);
    await expect(manager.start()).rejects.toThrow(/closed/);
    await expect(attachment.scan('late')).rejects.toThrow(/closed|admission/);
  } finally {
    release();
    // Typed, so source retirement can settle the exit as its own outcome (BST-2135).
    await expect(result).resolves.toBeInstanceOf(IndexerUtilityExitedError);
    await manager.close();
  }
  expect(engine.close).not.toHaveBeenCalled();
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
