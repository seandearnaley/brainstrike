// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import {
  type CanonicalRemoteWorkspaceDependencies,
  CanonicalUtilityParent,
} from '../canonical-utility-parent';
import { CANONICAL_CHANNEL, decodeCanonicalFrame } from '../canonical-utility-protocol';
import { IndexerHostManager } from '../indexer-host-manager';
import { IndexerUtilityExitedError } from '../indexer-utility-exit';
import { NativeAuthorityTransitionError } from '../native-authority-transition';
import { reportNativeIndexActivationError } from '../native-index-activation-error';
import {
  type NativeIndexSources,
  settleNativeIndexSources,
} from '../native-index-source-retirement';

const engine = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  exited: false,
}));
let child: EventEmitter & { postMessage: (message: unknown) => void; kill: () => boolean };
/** The answer to the one canonical call `answering` holds. */
let held: (() => void) | undefined;
/** When set, the indexer connection becomes ready only when the test resolves it. */
let heldReady: Promise<unknown> | undefined;
let owner = '';

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

/** A workspace owner on `rootId`; `read` gates its lease's reads, `retire` is its lease's retirement. */
function workspace({
  read = async () => {},
  retire = async () => {},
  rootId = 'root',
}: {
  read?: () => Promise<void>;
  retire?: (() => Promise<void>) | undefined;
  rootId?: string;
} = {}): CanonicalRemoteWorkspaceDependencies {
  const scope = { kind: 'workspace' as const, rootId };
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
    managedCollectionId: 'set',
    onError: vi.fn(),
    onReceipt: vi.fn(),
    onWatchHealth: vi.fn(),
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
    source: {
      indexingPolicyPreset: 'balanced',
      inventory: { loadFiles: async () => [] },
      lease: {
        canonicalPath: `/actual/${rootId}`,
        generation: 'generation',
        listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
        readFile: vi.fn(async () => {
          await read();
          return { status: 'not-found' as const };
        }),
        retire: vi.fn(retire),
        rootId,
        signal: new AbortController().signal,
        subscribe: vi.fn(async () => ({ close: async () => {} })),
      },
    },
  };
}
function host(closeMs = 100): Promise<IndexerHostManager> {
  return IndexerHostManager.create(
    {
      dbPath: '/explicit/derived.sqlite',
      embedding: { indexMode: 'text-only' },
      fileBindings: [],
      rootIds: ['root', 'other'],
      scopes: [
        { kind: 'workspace', rootId: 'root' },
        { kind: 'workspace', rootId: 'other' },
      ],
    },
    { closeMs },
    '/explicit/entry.js'
  );
}
/** A utility that answers every canonical call at once, except a `hold` call: `held` answers it. */
function answering(hold?: string): void {
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
          owner: frame.owner,
          value: null,
        });
      };
      if (frame.op === hold) {
        held = respond;
      } else {
        queueMicrotask(respond);
      }
    },
  });
}
/** The utility asks Main to read `x.ts` through the attachment's lease. */
function readFromUtility(): void {
  child.emit('message', {
    channel: CANONICAL_CHANNEL,
    id: 10,
    kind: 'call',
    op: 'read-file',
    owner,
    payload: { maxBytes: 10, relativePath: 'x.ts' },
    requestId: 'pass',
  });
}
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  held = undefined;
  heldReady = undefined;
  engine.exited = false;
});

// BST-2140 (Codex P1): the shutdown fence races an attachment still awaiting the host's start.
it('refuses an attachment the fence overtook in start, with the typed retirement and no session', async () => {
  const frames: unknown[] = [];
  child = Object.assign(new EventEmitter(), {
    kill: () => true,
    postMessage: (input: unknown): void => {
      frames.push(input);
    },
  });
  const ready = Promise.withResolvers<unknown>();
  heldReady = ready.promise;
  const manager = await host();
  const dependencies = workspace();
  const acquiring = manager.attachCanonicalWorkspace(dependencies).catch((error: unknown) => error);
  await flush();
  manager.fenceCanonicalSources();
  ready.resolve(engine);
  expect(await acquiring).toBeInstanceOf(NativeAuthorityTransitionError);
  // No session: the utility never received an attach, so no callback or scan can start.
  expect(frames).toEqual([]);
  expect(dependencies.source.lease.readFile).not.toHaveBeenCalled();
  await manager.close();
});

it('joins a slow cancellation control without closing admission, and joins admitted main IO before engine close', async () => {
  vi.useFakeTimers();
  answering('cancel');
  const manager = await host();
  const read = Promise.withResolvers<void>();
  const dependencies = workspace({ read: () => read.promise });
  const attachment = await manager.attachCanonicalWorkspace(dependencies);
  readFromUtility();
  await flush();
  expect(dependencies.source.lease.readFile).toHaveBeenCalledOnce();
  let cancelled = false;
  const cancel = attachment.cancel().then(() => {
    cancelled = true;
  });
  // Lifecycle R2: a slow control is load. Nothing refuses it, and admission stays open.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(cancelled).toBe(false);
  await expect(manager.start()).resolves.toBeDefined();
  held?.();
  await cancel;
  const close = manager.close();
  await flush();
  expect(engine.close).not.toHaveBeenCalled();
  read.resolve();
  await close;
  expect(engine.close).toHaveBeenCalledOnce();
});

it('fences an attachment at physical utility exit and rejects its pending control only after admitted main IO joins', async () => {
  answering('trigger');
  const manager = await host();
  const read = Promise.withResolvers<void>();
  const dependencies = workspace({ read: () => read.promise });
  const attachment = await manager.attachCanonicalWorkspace(dependencies);
  readFromUtility();
  await flush();
  expect(dependencies.source.lease.readFile).toHaveBeenCalledOnce();
  const result = attachment.trigger().catch((error: unknown) => error);
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
    await expect(manager.start()).rejects.toThrow(/closed/u);
  } finally {
    read.resolve();
    // Typed, so source retirement can settle the exit as its own outcome (BST-2135).
    await expect(result).resolves.toBeInstanceOf(IndexerUtilityExitedError);
    await manager.close();
  }
  expect(engine.close).not.toHaveBeenCalled();
});

it('retires canonical sources without closing the engine and permits a fresh source attachment', async () => {
  answering();
  const manager = await host();
  const original = await manager.start();
  await manager.attachCanonicalWorkspace(workspace());
  await manager.retireCanonicalSources();
  expect(await manager.start()).toBe(original);
  expect(engine.close).not.toHaveBeenCalled();
  expect(engine.destroy).not.toHaveBeenCalled();
  await manager.attachCanonicalWorkspace(workspace());
  await manager.close();
  expect(engine.close).toHaveBeenCalledOnce();
});

/**
 * The group signal is already ending the utility when source retirement asks its owners to close
 * (BST-2192, job 118273313326): it answers every earlier frame, and no `close`. Resolves once
 * `owners` close frames wait for an answer.
 */
function dyingOnClose(owners: number): Promise<void> {
  const asked = Promise.withResolvers<void>();
  let closes = 0;
  child = Object.assign(new EventEmitter(), {
    kill: () => true,
    postMessage: (input: unknown): void => {
      const frame = decodeCanonicalFrame(input);
      if (frame.kind !== 'call') {
        return;
      }
      if (frame.op === 'close') {
        closes += 1;
        if (closes === owners) {
          asked.resolve();
        }
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
  return asked.promise;
}

/** A started host with the two folder owners the hosted run retired. */
async function attachedSources(
  retireLease?: () => Promise<void>
): Promise<{ manager: IndexerHostManager; sources: NativeIndexSources }> {
  const manager = await host(1000);
  const attachments = new Set([
    await manager.attachCanonicalWorkspace(workspace({ retire: retireLease })),
    await manager.attachCanonicalWorkspace(workspace({ rootId: 'other' })),
  ]);
  const sources: NativeIndexSources = {
    attachments,
    controller: new AbortController(),
    inference: new Set(),
    leases: new Map(),
    workspaceTriggers: new Map(),
  };
  return { manager, sources };
}

// BST-2192 (job 118273313326): Main's source retirement began before it observed the indexer's
// exit, so its close frames were waiting when the group signal ended the utility. Every owner
// ended with that exit alone, so retirement settles it as the typed exit, which the activation
// reports at error, and at info only while quitting.
it.each([false, true])(
  'settles retirement the utility exit overtook on its close frames as that exit (quitting=%s)',
  async (quitting) => {
    const asked = dyingOnClose(2);
    const { manager, sources } = await attachedSources();
    const logger = { error: vi.fn(), info: vi.fn() };
    let retiring: Promise<void> | undefined;
    const settling = settleNativeIndexSources(
      sources,
      () => {
        retiring = manager.retireCanonicalSources();
        return retiring;
      },
      (exit) =>
        reportNativeIndexActivationError(
          'Native indexing source retirement failed',
          exit,
          quitting,
          logger
        )
    );
    await asked;
    engine.exited = true;
    child.emit('exit');
    await expect(settling).resolves.toBeUndefined();
    await expect(retiring).rejects.toBeInstanceOf(IndexerUtilityExitedError);
    if (quitting) {
      expect(logger.info).toHaveBeenCalledExactlyOnceWith(
        'Native indexer utility exited before shutdown retired its attachments',
        { reason: 'Indexer utility exited.' }
      );
      expect(logger.error).not.toHaveBeenCalled();
    } else {
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        'Native indexing source retirement failed',
        { error: expect.any(IndexerUtilityExitedError) }
      );
      expect(logger.info).not.toHaveBeenCalled();
    }
    await manager.close();
  }
);

it('keeps retirement the exit overtook beside an independent Main failure owned', async () => {
  const asked = dyingOnClose(2);
  const failure = new Error('lease retirement failed');
  const retireLease = vi.fn(async (): Promise<void> => {
    throw failure;
  });
  const { manager, sources } = await attachedSources(retireLease);
  const onExited = vi.fn();
  let retiring: Promise<void> | undefined;
  const settling = settleNativeIndexSources(
    sources,
    () => {
      retiring = manager.retireCanonicalSources();
      return retiring;
    },
    onExited
  ).catch((error: unknown) => error);
  await asked;
  engine.exited = true;
  child.emit('exit');
  expect(await settling).toMatchObject({
    message: 'Canonical utility attachments did not retire.',
  });
  expect(onExited).not.toHaveBeenCalled();
  const retired = await retiring?.catch((error: unknown) => error);
  expect(retired).toBeInstanceOf(AggregateError);
  expect(retired).toMatchObject({ message: 'Canonical utility attachments remain owned.' });
  const [failedOwner, exitedOwner] = (retired as AggregateError).errors as unknown[];
  expect(failedOwner).toMatchObject({
    message: 'Canonical attachment retirement remains owned.',
  });
  expect(exitedOwner).toBeInstanceOf(IndexerUtilityExitedError);
  // Retained: once the lease retires, the close joins what Main still owned.
  retireLease.mockImplementation(async () => {});
  await manager.close();
});

/** Two folder owners whose utility then dies: no later frame is ever answered. */
async function ownersUntilExit(): Promise<{ owners: string[]; parent: CanonicalUtilityParent }> {
  let alive = true;
  const owners: string[] = [];
  const parent = new CanonicalUtilityParent((input) => {
    const frame = decodeCanonicalFrame(input);
    if (!alive || frame.kind !== 'call') {
      return;
    }
    owners.push(frame.owner);
    queueMicrotask(() =>
      parent.receive({
        channel: CANONICAL_CHANNEL,
        id: frame.id,
        kind: 'result',
        ok: true,
        owner: frame.owner,
        value: null,
      })
    );
  }, vi.fn());
  await parent.attachWorkspace(workspace());
  await parent.attachWorkspace(workspace({ rootId: 'other' }));
  alive = false;
  return { owners, parent };
}

it.each(['retireAttachments', 'close'] as const)(
  '%s rejects with the exit object itself when that exit ended every owner (BST-2192)',
  async (method) => {
    const { parent } = await ownersUntilExit();
    const exit = new IndexerUtilityExitedError();
    const closing = parent[method]();
    await parent.exited(exit);
    await expect(closing).rejects.toBe(exit);
  }
);

it("keeps an exit-shaped failure that is not the utility's own exit an owned retirement", async () => {
  const { owners, parent } = await ownersUntilExit();
  const exit = new IndexerUtilityExitedError();
  const lookalike = new IndexerUtilityExitedError();
  const closeOwner = parent.closeOwner.bind(parent);
  vi.spyOn(parent, 'closeOwner').mockImplementation((owner) =>
    owner === owners[1] ? Promise.reject(lookalike) : closeOwner(owner)
  );
  const retiring = parent.retireAttachments().catch((error: unknown) => error);
  await parent.exited(exit);
  const outcome = await retiring;
  expect(outcome).toBeInstanceOf(AggregateError);
  expect(outcome).toMatchObject({ message: 'Canonical utility attachments remain owned.' });
  const [own, other] = (outcome as AggregateError).errors as unknown[];
  expect(own).toBe(exit);
  expect(other).toBe(lookalike);
});

it('never takes a failure for the exit while the utility lives, not even one with no reason', async () => {
  const { parent } = await ownersUntilExit();
  // Before any exit the parent holds no exit object: a reasonless rejection must not match it.
  vi.spyOn(parent, 'closeOwner').mockImplementation(() => Promise.reject(undefined));
  const outcome = await parent.retireAttachments().catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(AggregateError);
  expect(outcome).toMatchObject({
    errors: [undefined, undefined],
    message: 'Canonical utility attachments remain owned.',
  });
});
