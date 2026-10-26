// @vitest-environment node
import type {
  CanonicalWorkspaceLease,
  NativeCanonicalInference,
} from '@brainstrike/canonical-ingestion';
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { CoverageAuthorityPort } from '@brainstrike/indexer/coverage-reader';
import { beforeEach, expect, it, vi } from 'vitest';
import { CanonicalUtilityChild } from '../canonical-utility-child';
import {
  type CanonicalRemoteWorkspaceDependencies,
  CanonicalUtilityParent,
} from '../canonical-utility-parent';
import { decodeCanonicalFrame } from '../canonical-utility-protocol';
import { createDesktopProfileRuntime } from '../desktop-profile-runtime';
import { createDesktopHostLease } from '../host-lease-manager';
import { IndexerUtilityExitedError } from '../indexer-utility-exit';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { createNativeIndexActivation } from '../native-index-activation';
import {
  type NativeIndexSources,
  retireNativeIndexSources,
  settleNativeIndexSources,
} from '../native-index-source-retirement';
import { textSettings } from './helpers/native-index-settings';
import { restoredRoots } from './helpers/restored-roots';
import { createActivationCatalogFixture } from './native-activation-catalog-fixture';

const catalogFixture = createActivationCatalogFixture();

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(),
  closeProfile: vi.fn(),
  closeReaders: vi.fn(),
  destroy: vi.fn(),
  fence: vi.fn(),
  manager: {
    attachCanonicalWorkspace: vi.fn(),
    retireCanonicalSources: vi.fn(),
    start: vi.fn(),
  },
  readyPort: vi.fn(),
}));
vi.mock('../desktop-database-location', () => ({
  resolveDesktopDatabaseProfileDirectory: () => '/owned/profile',
}));
vi.mock('../host-lease-manager', () => ({
  createDesktopHostLease: () => ({ acquire: async () => {}, close: mocks.closeProfile }),
}));
vi.mock('../indexer-runtime', () => ({
  acquireIndexerHost: mocks.acquire,
  closeIndexerRuntime: mocks.close,
  destroyIndexerRuntime: mocks.destroy,
  fenceIndexerCanonicalSources: mocks.fence,
  getReadyIndexerHost: () => mocks.manager,
  getReadyScopedIndexerPort: mocks.readyPort,
}));
vi.mock('../sqlite-query-host-manager', () => ({
  closeAllIndexQueries: mocks.closeReaders,
  installIndexQueryTarget: vi.fn(),
  openIndexCoverage: async () => {
    const port: ScopedIndexerPort = mocks.readyPort();
    return {
      close: async () => undefined,
      nativeCoverage: async (requests: readonly unknown[]) =>
        Promise.all(requests.map((request) => port.coverageScope(request))),
    };
  },
  retireAllIndexQueries: mocks.closeReaders,
}));

const storeId = 'a'.repeat(64);
const workspace = { kind: 'workspace', rootId: 'root' } as const;
const unused = async (): Promise<never> => {
  throw new Error('Unexpected legacy or inference operation.');
};
function writer(): IndexerPort & ScopedIndexerPort & CoverageAuthorityPort {
  return {
    close: unused,
    commitFile: unused,
    commitScopedFile: unused,
    commitScopedTextFile: unused,
    commitTextFile: unused,
    configureVectorProfile: unused,
    coverage: unused,
    coverageAuthority: async () => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      dbPath: '/owned/profile/index.sqlite',
      fileBindings: [],
      rootIds: [],
      scopes: [workspace],
      storeId,
    }),
    coverageBatch: unused,
    coverageScope: unused,
    destroy: unused,
    info: async () => ({
      dbPath: '/owned/profile/index.sqlite',
      embedding: { indexMode: 'text-only' },
      journalMode: 'wal',
      pid: 1,
      readerQueryOnly: 1,
      storeId,
      vecVersion: '0.1.9',
      writerThreadId: 1,
    }),
    prepareFile: unused,
    prepareScopedFile: unused,
    readScopedFileChunkBounds: unused,
    readScopedFilePage: unused,
    removeFile: unused,
    removeScopedFile: unused,
    replaceFileBindings: async () => {},
    search: unused,
    searchScopes: unused,
    verifyManifest: unused,
    verifyScopedManifest: async ({ scope }) => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      changed: [],
      complete: true,
      missing: [],
      scope,
      storeId,
      unexpected: [],
    }),
  };
}
function fixture(applicationOverride?: ApplicationIpcDomain) {
  const application = {
    roots: restoredRoots({ restoreRoots: async () => [] }),
    watches: {},
  } as unknown as ApplicationIpcDomain;
  const transport = { destroyAndRestart: vi.fn(unused), documentEmbeddings: vi.fn(unused) };
  const onReceipt = vi.fn();
  const activation = createNativeIndexActivation({
    application: applicationOverride ?? application,
    catalog: catalogFixture.catalog,
    embedding: transport,
    modelCatalog: catalogFixture.modelCatalog,
    onError: vi.fn(),
    onReceipt,
    profile: createDesktopProfileRuntime(() => createDesktopHostLease({ root: '/owned/profile' })),
    settings: async () => textSettings(),
    storage: { getItem: unused },
  });
  return { activation, onReceipt, transport };
}
beforeEach(() => {
  vi.resetAllMocks();
  catalogFixture.reset();

  mocks.acquire.mockResolvedValue(writer());
  mocks.readyPort.mockReturnValue(writer());
  mocks.close.mockResolvedValue(undefined);
  mocks.destroy.mockResolvedValue(undefined);
  mocks.closeReaders.mockResolvedValue(undefined);
  mocks.closeProfile.mockResolvedValue(undefined);
  mocks.manager.retireCanonicalSources.mockResolvedValue(undefined);
  mocks.manager.start.mockResolvedValue(writer());
});

it.each([
  { failedWatch: false, failure: undefined, name: 'owned cancellation' },
  {
    failedWatch: false,
    failure: new Error('Native ingestion paused.'),
    name: 'independent pause text',
  },
  {
    failedWatch: false,
    failure: new Error('independent permission failure'),
    name: 'independent permission fault',
  },
  { failedWatch: true, failure: undefined, name: 'failed watch unsubscribe' },
])(
  'joins an admitted folder request and its watch retirement with $name',
  async ({ failure, failedWatch }) => {
    const requestEntered = Promise.withResolvers<void>();
    const requestRelease = Promise.withResolvers<void>();
    const watchEntered = Promise.withResolvers<void>();
    const watchRelease = Promise.withResolvers<void>();
    const closeSent = Promise.withResolvers<void>();
    const replies: object[] = [];
    const parent = new CanonicalUtilityParent((frame) => {
      replies.push(structuredClone(frame));
      const sent = decodeCanonicalFrame(frame);
      if (sent.kind === 'call' && sent.op === 'close') {
        closeSent.resolve();
      }
      queueMicrotask(() => child.receive(structuredClone(frame)));
    }, vi.fn());
    const child = new CanonicalUtilityChild((frame) =>
      queueMicrotask(() => parent.receive(structuredClone(frame)))
    );
    let attachment!: Awaited<ReturnType<CanonicalUtilityParent['attachWorkspace']>>;
    let triggered = false;
    let heldId: number | undefined;
    let heldOwner: string | undefined;
    const originalReceive = parent.receive.bind(parent);
    vi.spyOn(parent, 'receive').mockImplementation((input) => {
      const frame = decodeCanonicalFrame(input);
      if (triggered && heldId === undefined && frame.kind === 'call' && frame.op === 'load-files') {
        heldId = frame.id;
        heldOwner = frame.owner;
      }
      originalReceive(input);
    });
    mocks.manager.attachCanonicalWorkspace.mockImplementation(
      async (dependencies: CanonicalRemoteWorkspaceDependencies) => {
        const inventory = dependencies.source.inventory;
        attachment = await parent.attachWorkspace({
          ...dependencies,
          source: {
            ...dependencies.source,
            inventory: {
              ...inventory,
              loadFiles: async (requested, context) => {
                if (!triggered) {
                  return inventory.loadFiles(requested, context);
                }
                // The triggered scan's inventory read is admitted, then held past retirement.
                requestEntered.resolve();
                await requestRelease.promise;
                if (failure) {
                  throw failure;
                }
                context.signal.throwIfAborted();
                return inventory.loadFiles(requested, context);
              },
            },
          },
        });
        return attachment;
      }
    );
    mocks.manager.retireCanonicalSources.mockImplementation(() => parent.retireAttachments());
    catalogFixture.setRoot();
    let unsubscribeFailed = false;
    const unsubscribe = vi.fn(async () => {
      watchEntered.resolve();
      await watchRelease.promise;
      if (failedWatch && !unsubscribeFailed) {
        unsubscribeFailed = true;
        throw new Error('independent watch unsubscribe failure');
      }
    });
    const retire = vi.fn(async () => {});
    const application = {
      roots: restoredRoots({
        borrowSourceRoot: async (): Promise<CanonicalWorkspaceLease> => ({
          canonicalPath: '/actual/root',
          generation: 'generation',
          listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
          readFile: unused,
          retire,
          rootId: 'root',
          signal: new AbortController().signal,
          subscribe: async () => ({ close: unsubscribe }),
        }),
        restoreRoots: async () => [{ permissionState: 'granted', rootId: 'root' }],
      }),
      watches: { subscribe: unused },
    } as unknown as ApplicationIpcDomain;
    const native = writer();
    const verify = vi.fn(native.verifyScopedManifest);
    native.verifyScopedManifest = verify;
    mocks.readyPort.mockReturnValue(native);
    const { activation, onReceipt } = fixture(application);
    await activation.acquire();
    expect(onReceipt).toHaveBeenCalledOnce();
    const verificationCalls = verify.mock.calls.length;
    triggered = true;
    await attachment.trigger();
    await requestEntered.promise;
    const retired = activation.close();
    const settled = retired.then(
      () => ({ ok: true }),
      (error: unknown) => ({ error, ok: false })
    );
    // Retirement reached the folder's attachment while its admitted request is still held.
    await closeSent.promise;
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    requestRelease.resolve();
    // The attachment's watch retires once its scan has ended.
    await watchEntered.promise;
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    watchRelease.resolve();
    const outcome = await settled;
    const reply = replies
      .map(decodeCanonicalFrame)
      .find((frame) => frame.kind === 'result' && frame.id === heldId && frame.owner === heldOwner);
    if (failure) {
      // The work this retirement cancelled ended on its own failure: Main still answers it with
      // that failure, and the retirement does not fail with it.
      expect(reply).toMatchObject({
        error: { message: failure.message },
        kind: 'result',
        ok: false,
      });
      expect(reply).not.toHaveProperty('cancelled', true);
    } else {
      expect(reply).toMatchObject({ cancelled: true, kind: 'result', ok: false });
    }
    if (failedWatch) {
      // A watch that does not close keeps the retirement failed until an explicit retry.
      expect(outcome).toMatchObject({ ok: false });
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.closeProfile).not.toHaveBeenCalled();
      await activation.close();
    } else {
      expect(outcome).toEqual({ ok: true });
    }
    expect(onReceipt).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledTimes(verificationCalls);
    expect(unsubscribe).toHaveBeenCalled();
    expect(retire).toHaveBeenCalled();
    expect(child.channel.pendingCount).toBe(0);
    expect(parent.channel.pendingCount).toBe(0);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeProfile).toHaveBeenCalledOnce();
    await parent.close();
  }
);

it('joins capabilities after a synchronous parent retirement fault and retains failed inference for retry', async () => {
  const controller = new AbortController();
  const joined = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const failure = new DOMException('independent inference retirement failure', 'AbortError');
  const parentFailure = new Error('independent parent retirement failure');
  const closeInference = vi.fn(async (): Promise<void> => {
    entered.resolve();
    await joined.promise;
    throw failure;
  });
  const inference = { close: closeInference } as unknown as NativeCanonicalInference;
  const sources: NativeIndexSources = {
    attachments: new Set(),
    controller,
    inference: new Set([inference]),
    leases: new Map(),
    workspaceTriggers: new Map(),
  };
  const retire = vi.fn((): Promise<void> => {
    expect(controller.signal.aborted).toBe(false);
    throw parentFailure;
  });
  const retirement = retireNativeIndexSources(sources, retire);
  const outcome = retirement.catch((error: unknown) => error);
  await entered.promise;
  expect(controller.signal.aborted).toBe(true);
  expect(sources.inference.has(inference)).toBe(true);
  joined.resolve();
  expect(await outcome).toMatchObject({ errors: [failure, parentFailure] });
  expect(sources.inference.has(inference)).toBe(true);
  closeInference.mockResolvedValue(undefined);
  await retireNativeIndexSources(sources, async () => {});
  expect(sources.inference.size).toBe(0);
});

// BST-2135: a signal to Main's process group ends the indexer utility before shutdown retires it.
function exitedUtilitySources(leaseRetire: () => Promise<void>) {
  const attachment = {
    close: vi.fn(async () => {
      throw new IndexerUtilityExitedError();
    }),
  };
  const lease = { retire: vi.fn(leaseRetire) } as unknown as CanonicalWorkspaceLease;
  const sources: NativeIndexSources = {
    attachments: new Set([attachment]),
    controller: new AbortController(),
    inference: new Set(),
    leases: new Map([['root', lease]]),
    workspaceTriggers: new Map(),
  };
  const retireParent = async (): Promise<void> => {
    throw new IndexerUtilityExitedError();
  };
  return { attachment, lease, retireParent, sources };
}

it('settles an exited utility as its typed outcome once Main retired its own capabilities', async () => {
  const exited = exitedUtilitySources(async () => {});
  await expect(
    retireNativeIndexSources(exited.sources, exited.retireParent)
  ).rejects.toBeInstanceOf(IndexerUtilityExitedError);
  const { attachment, lease, retireParent, sources } = exitedUtilitySources(async () => {});
  const onExited = vi.fn();
  await settleNativeIndexSources(sources, retireParent, onExited);
  expect(onExited).toHaveBeenCalledExactlyOnceWith(expect.any(IndexerUtilityExitedError));
  expect(lease.retire).toHaveBeenCalledOnce();
  expect(sources.leases.size).toBe(0);
  // Nothing retired through the dead utility: its attachment is never recorded as retired.
  expect(sources.attachments.has(attachment)).toBe(true);
});

it('keeps an independent failure beside the utility exit a retained retirement failure', async () => {
  const failure = new Error('independent lease retirement failure');
  const { retireParent, sources } = exitedUtilitySources(async () => {
    throw failure;
  });
  const onExited = vi.fn();
  const outcome = await settleNativeIndexSources(sources, retireParent, onExited).catch(
    (error: unknown) => error
  );
  expect(outcome).toBeInstanceOf(AggregateError);
  expect((outcome as AggregateError).message).toBe('Canonical utility attachments did not retire.');
  expect((outcome as AggregateError).errors).toContain(failure);
  expect(onExited).not.toHaveBeenCalled();
  expect(sources.leases.size).toBe(1);
});

// BST-2140: the shutdown fence must stop the utility's admitted requests in the turn it revokes
// the native graph, or their failures on that revocation answer as ordinary failures.
it('fences the utility attachments whenever the lifecycle fences admitted native work', async () => {
  const { activation } = fixture();
  activation.fenceTerminal();
  await vi.waitFor(() => expect(mocks.fence).toHaveBeenCalledOnce());
  await activation.close();
});
