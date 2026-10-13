// @vitest-environment node

import { join } from 'node:path';
import type {
  CanonicalIngestionDependencies,
  CanonicalScanReceipt,
  CanonicalSourceScope,
  CanonicalVectorPublicationPort,
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
} from '@brainstrike/canonical-ingestion';
import {
  DEFAULT_MAX_FILE_SIZE,
  resetFileSizeConfig,
  setFileSizeConfig,
} from '@brainstrike/file-system';
import { readResolvedWorkspaceFile } from '@brainstrike/file-system/secure-file-read';
import {
  type ScopedFilePlan,
  type ScopedIndexerPort,
  vectorProfileHash,
} from '@brainstrike/indexer';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { CanonicalUtilityChild } from '../canonical-utility-child';
import {
  type CanonicalCollectionDependencies,
  CanonicalUtilityParent,
} from '../canonical-utility-parent';
import { decodeCanonicalFrame } from '../canonical-utility-protocol';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import type { NativeCanonicalCatalogRecord } from '../native-canonical-catalog';
import {
  createInitialWindowAfterNativeReader,
  observeNativeReaderStartup,
} from '../native-index-startup-window';
import { createNativeScopedSearchCapability } from '../native-scoped-search';
import {
  createActivation,
  emptyCollection,
  fixture,
  mocks,
  requestedScope,
  resetActivationFixture,
  saveSettingsChange,
  scope,
  setCatalogRecords,
  setCatalogRoot,
  storeId,
  unused,
  writer,
} from './native-index-activation-fixture';

beforeEach(resetActivationFixture);
afterEach(resetFileSizeConfig);

it.each(['cancelled', 'startup-failed', 'cleanup-failed'] as const)(
  'joins replacement host startup on quit and preserves %s outcomes',
  async (outcome) => {
    const { activation } = fixture();
    const quit = new AbortController();
    const starting = Promise.withResolvers<void>();
    const physicalExit = Promise.withResolvers<void>();
    const unrelated = new Error('Independent host startup failure');
    const cleanupFailure = new Error('Physical host close failed');
    mocks.acquireProfile.mockReturnValueOnce(starting.promise);
    mocks.closeProfile.mockImplementationOnce(async (reason: unknown) => {
      starting.reject(outcome === 'startup-failed' ? unrelated : reason);
      await physicalExit.promise;
      if (outcome === 'cleanup-failed') {
        throw cleanupFailure;
      }
    });
    let settled = false;
    const resuming = activation.resume(quit.signal);
    const result = resuming.then(
      () => {
        settled = true;
        return;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    onTestFinished(async () => {
      quit.abort(new Error('Test cleanup'));
      physicalExit.resolve();
      starting.reject(quit.signal.reason);
      await result;
    });
    await vi.waitFor(() => expect(mocks.acquireProfile).toHaveBeenCalledOnce());
    quit.abort(new Error('Terminal quit'));
    await vi.waitFor(() => expect(mocks.closeProfile).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    physicalExit.resolve();
    const failure = await result;
    if (outcome === 'cleanup-failed') {
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([quit.signal.reason, cleanupFailure]);
    } else {
      expect(failure).toBe(outcome === 'startup-failed' ? unrelated : quit.signal.reason);
    }
    expect(mocks.createProfileOwner).toHaveBeenCalledOnce();
    await expect(activation.acquireProfile()).rejects.toThrow('terminal retirement');
  }
);

it('refuses reset resume before profile admission when quit is already terminal', async () => {
  const { activation } = fixture();
  const quit = new AbortController();
  quit.abort(new Error('Terminal quit'));
  await expect(activation.resume(quit.signal)).rejects.toBe(quit.signal.reason);
  expect(mocks.createProfileOwner).not.toHaveBeenCalled();
});

it('retains the assistant profile through index settings replacement and rebuild until terminal close', async () => {
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation, storage } = fixture();
  try {
    await activation.acquireProfile();
    await activation.acquire();
    await saveSettingsChange(storage, { indexingPolicyPreset: 'full-root' });
    await activation.reconfigure();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    await activation.rebuild();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    await activation.acquireProfile();
  } finally {
    await activation.close();
  }
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
});

it('retries a failed host start once that host has released Root; Main retirement stays terminal', async () => {
  const { activation } = fixture();
  try {
    // The failed start's rollback closes its platform, which releases Root capabilities.
    mocks.acquireProfile.mockImplementationOnce(async () => {
      await activation.closeRootCapabilities();
      throw new Error('Host startup timed out');
    });
    await expect(activation.acquireProfile()).resolves.toBeUndefined();
    expect(mocks.createProfileOwner).toHaveBeenCalledTimes(2);
    expect(mocks.closeProfile).toHaveBeenCalledOnce();
  } finally {
    await activation.close();
  }
  await expect(activation.acquireProfile()).rejects.toThrow('terminal retirement');
});

it('keeps Main retirement terminal when a starting host fails and releases Root under it', async () => {
  const { activation } = fixture();
  const starting = Promise.withResolvers<void>();
  const failing = Promise.withResolvers<void>();
  mocks.acquireProfile.mockImplementationOnce(async () => {
    starting.resolve();
    await failing.promise;
    // The failed start's rollback closes its platform, which releases Root capabilities.
    await activation.closeRootCapabilities();
    throw new Error('MCP is unavailable: the agent host is not running.');
  });
  const connecting = activation.acquireProfile();
  await starting.promise;
  // App shutdown begins while the host is still starting.
  const closing = activation.close();
  failing.resolve();
  await expect(connecting).rejects.toThrow('MCP is unavailable');
  await closing;
  expect(mocks.createProfileOwner).toHaveBeenCalledOnce();
});

it('shows a failure that persists after the retry, and a later admission starts again', async () => {
  const { activation } = fixture();
  try {
    mocks.acquireProfile
      .mockRejectedValueOnce(new Error('first start failed'))
      .mockRejectedValueOnce(new Error('retry failed'));
    await expect(activation.acquireProfile()).rejects.toThrow('retry failed');
    await expect(activation.acquireProfile()).resolves.toBeUndefined();
    expect(mocks.createProfileOwner).toHaveBeenCalledTimes(3);
  } finally {
    await activation.close();
  }
});

it('acquires the workspace index.sqlite with no state truth root or projection', async () => {
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation } = fixture();
  try {
    await activation.acquire();
  } finally {
    await activation.close();
  }
  // The host's own state-index.sqlite owns state rows; this file must never project them too.
  expect(mocks.acquire).toHaveBeenCalledOnce();
  const [options] = mocks.acquire.mock.calls[0] ?? [];
  expect(options).toMatchObject({ dbPath: join('/owned/profile', 'index.sqlite') });
  expect(options).not.toHaveProperty('stateRoot');
  expect(options).not.toHaveProperty('stateProjection');
  expect(options).not.toHaveProperty('stateResources');
});

it.each([DEFAULT_MAX_FILE_SIZE, 4096])(
  'activates ordinary TEXT source reads with the actual configured %i-byte limit',
  async (maxFileSize) => {
    setFileSizeConfig({ maxFileSize });
    const readFile = vi.fn(async (_relativePath: string, _maxBytes: number) => ({
      content: Buffer.from('ordinary source'),
      status: 'ok' as const,
    }));
    mocks.manager.attachCanonicalCollection.mockImplementation(
      async (dependencies: CanonicalCollectionDependencies) => {
        const content = await readResolvedWorkspaceFile(
          '/workspace/ordinary.txt',
          {
            mounted: { root: { readFile } },
            relativePath: 'ordinary.txt',
            traversedSymlink: false,
          },
          dependencies.request.maxFileBytes
        );
        expect(content).toBe('ordinary source');
        return emptyCollection(dependencies);
      }
    );
    const { activation, onReceipt, transport } = fixture();
    try {
      await activation.acquire();
      expect(readFile).toHaveBeenCalledExactlyOnceWith('ordinary.txt', maxFileSize);
      expect(onReceipt).toHaveBeenCalledOnce();
      expect(transport.documentEmbeddings).not.toHaveBeenCalled();
    } finally {
      await activation.close();
    }
  }
);

it('joins real late source cancellation before closing the native engine and profile owner', async () => {
  const request = Promise.withResolvers<object>();
  const cancelled = Promise.withResolvers<object>();
  const parent = new CanonicalUtilityParent(
    (frame) => queueMicrotask(() => child.receive(structuredClone(frame))),
    vi.fn()
  );
  const child = new CanonicalUtilityChild((input) => {
    const frame = decodeCanonicalFrame(input);
    if (frame.kind === 'call' && frame.op === 'load-files') {
      request.resolve(structuredClone(input));
      return;
    }
    if (frame.kind === 'cancel') {
      cancelled.resolve(structuredClone(input));
      return;
    }
    queueMicrotask(() => parent.receive(structuredClone(input)));
  });
  mocks.manager.attachCanonicalCollection.mockImplementation(
    (dependencies: CanonicalCollectionDependencies) => parent.attachCollection(dependencies)
  );
  mocks.manager.retireCanonicalSources.mockImplementation(() => parent.retireAttachments());
  const { activation } = fixture();
  const initial = activation.acquire().catch((error: unknown) => error);
  const held = await request.promise;
  const retirement = activation.close();
  const notice = await cancelled.promise;
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.closeProfile).not.toHaveBeenCalled();
  parent.receive(held);
  parent.receive(notice);
  await retirement;
  await initial;
  expect(child.channel.pendingCount).toBe(0);
  expect(parent.channel.pendingCount).toBe(0);
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
  await parent.close();
});

it('closes an admitted initial collection scan before joining startup, and joins physical retirement', async () => {
  const scan = Promise.withResolvers<CanonicalScanReceipt>();
  const physical = Promise.withResolvers<void>();
  const close = vi.fn(async () => {
    await physical.promise;
    scan.reject(new Error('Owned scan retired.'));
  });
  mocks.manager.attachCanonicalCollection.mockResolvedValue({ close, scan: () => scan.promise });
  const { activation } = fixture();
  const initial = activation.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(mocks.manager.attachCanonicalCollection).toHaveBeenCalledOnce());
  let settled = false;
  const retiring = activation.destroyAndRetireProfile().then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  expect(mocks.destroy).not.toHaveBeenCalled();
  await expect(activation.acquire()).rejects.toThrow('closed');
  physical.resolve();
  await retiring;
  expect(await initial).toBeInstanceOf(Error);
  expect(mocks.destroy).toHaveBeenCalledOnce();
  expect(mocks.closeProfile).toHaveBeenCalledOnce();
});

it('rebuilds only the derived writer with the saved collection and no inference or application deletion', async () => {
  const close = vi.fn(async () => {});
  const modes: CanonicalIngestionDependencies['mode'][] = [];
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalIngestionDependencies) => {
      modes.push(dependencies.mode);
      return {
        close,
        scan: async (requestId: string) => {
          const ticket = await dependencies.publication.beginScan({ requestId, scope });
          return dependencies.publication.finishScan({
            aborted: false,
            errors: [],
            files: [],
            full: true,
            ticket,
            truncatedDirectories: [],
          });
        },
      };
    }
  );
  const { activation, storage, transport, onReceipt } = fixture();
  await activation.acquire();
  await activation.rebuild();
  expect(modes).toEqual(['TEXT', 'TEXT']);
  expect(close).toHaveBeenCalledOnce();
  expect(mocks.destroy).toHaveBeenCalledOnce();
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
  expect(transport.documentEmbeddings).not.toHaveBeenCalled();
  expect(storage.getItem).toHaveBeenCalledTimes(2);
  expect(
    mocks.catalog.sourceCatalog.mock.calls.every(([request]) =>
      ['inventory', 'read'].includes(request.operation)
    )
  ).toBe(true);
  expect(onReceipt).toHaveBeenCalledTimes(2);
  await activation.close();
});

it('retains a failed source close and refuses derived deletion until explicit retirement retry', async () => {
  const cause = new Error('Source remains physically owned.');
  const close = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue(undefined);
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalIngestionDependencies) => ({
      close,
      scan: async (requestId: string) => {
        const ticket = await dependencies.publication.beginScan({ requestId, scope });
        return dependencies.publication.finishScan({
          aborted: false,
          errors: [],
          files: [],
          full: true,
          ticket,
          truncatedDirectories: [],
        });
      },
    })
  );
  const { activation } = fixture();
  await activation.acquire();
  await expect(activation.destroyAndRetireProfile()).rejects.toMatchObject({ errors: [cause] });
  expect(mocks.destroy).not.toHaveBeenCalled();
  expect(mocks.closeProfile).not.toHaveBeenCalled();
  await expect(activation.acquire()).rejects.toThrow('closed');
  await activation.destroyAndRetireProfile();
  expect(close).toHaveBeenCalledTimes(2);
  expect(mocks.destroy).toHaveBeenCalledOnce();
});

it('exposes actual native progress while the initial owned collection scan is still running', async () => {
  const held = Promise.withResolvers<CanonicalScanReceipt>();
  mocks.manager.attachCanonicalCollection.mockResolvedValue({
    close: async () => {
      held.reject(new Error('Owned scan closed.'));
    },
    scan: () => held.promise,
  });
  const { activation } = fixture();
  const initial = activation.acquire().catch((error: unknown) => error);
  await vi.waitFor(() => expect(mocks.manager.attachCanonicalCollection).toHaveBeenCalledOnce());
  const scanSettled = vi.fn();
  void initial.then(scanSettled);
  const createWindow = vi.fn(async () => ({ id: 1 }));
  await expect(
    createInitialWindowAfterNativeReader(
      observeNativeReaderStartup(activation.acquireRead(), vi.fn()),
      createWindow,
      vi.fn(),
      () => false
    )
  ).resolves.toEqual({ id: 1 });
  expect(scanSettled).not.toHaveBeenCalled();
  expect(createWindow).toHaveBeenCalledOnce();
  expect((await activation.acquireRead()).info).toBeTypeOf('function');
  expect(await activation.getSearchAuthority()).toMatchObject({
    collectionId: 'selected',
    readiness: [expect.objectContaining({ scanComplete: false, scope })],
    rootIds: [],
  });
  await activation.close();
  expect(await initial).toBeInstanceOf(Error);
});

function catalogRows(count: number): NativeCanonicalCatalogRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    chunksProcessed: true,
    content: null,
    contentHash: 'c'.repeat(64),
    embeddingSetId: 'selected',
    fileId: `retained-${index}`,
    fileName: `retained-${index}.txt`,
    path: null,
    rootId: null,
    stat: { mtimeMs: 1, size: 1 },
  }));
}
function useCatalogRows(read: () => readonly NativeCanonicalCatalogRecord[]): void {
  setCatalogRecords(read);
}
it.each(['close', 'destroyAndRetireProfile'] as const)(
  'fences and joins held reconfiguration before %s acknowledges terminal retirement',
  async (operation) => {
    mocks.manager.attachCanonicalCollection.mockImplementation(
      async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
    );
    const { activation, storage } = fixture();
    await activation.acquire();
    const writerExit = Promise.withResolvers<void>();
    mocks.close.mockReturnValueOnce(writerExit.promise);
    await saveSettingsChange(storage, { indexingPolicyPreset: 'full-root' });
    const changing = activation.reconfigure().catch((error: unknown) => error);
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.closeProfile).not.toHaveBeenCalled();
    let terminalSettled = false;
    const terminal = activation[operation]().then(() => {
      terminalSettled = true;
    });
    await Promise.resolve();
    expect(terminalSettled).toBe(false);
    writerExit.resolve();
    await Promise.all([changing, terminal]);
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.closeProfile).toHaveBeenCalledOnce();
    await expect(activation.acquireRead()).rejects.toThrow('closed');
  }
);

it('refuses a nonexistent saved TEXT collection before opening a writer or completing a receipt', async () => {
  mocks.catalog.collections.mockResolvedValue({ collections: [] });
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation, onReceipt } = fixture();
  await expect(activation.acquire()).rejects.toThrow('saved native collection is missing');
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(onReceipt).not.toHaveBeenCalled();
  expect(mocks.manager.attachCanonicalCollection).not.toHaveBeenCalled();
  await activation.close();
});

it.each([251, 1501])(
  'loads the entire %i-file inventory through bounded actual catalog batches',
  async (count) => {
    const records = catalogRows(count);
    useCatalogRows(() => records);
    let inventory: readonly { readonly fileId: string }[] = [];
    mocks.manager.attachCanonicalCollection.mockImplementation(
      async (dependencies: CanonicalCollectionDependencies) => {
        const host = emptyCollection(dependencies);
        return {
          ...host,
          scan: async (requestId: string) => {
            inventory = await dependencies.source.inventory.loadFiles(dependencies.scope, {
              requestId,
              signal: new AbortController().signal,
            });
            return host.scan(requestId);
          },
        };
      }
    );
    const { activation } = fixture();
    await activation.acquire();
    expect(inventory.map((file) => file.fileId)).toEqual(records.map((record) => record.fileId));
    const batches = mocks.catalog.sourceCatalog.mock.calls
      .map(([request]) => request)
      .filter((request) => request.operation === 'read');
    expect(batches).toHaveLength(2 * Math.ceil(count / 250));
    expect(batches.every((request) => request.fileIds.length <= 250)).toBe(true);
    await activation.close();
  }
);

it('invalidates actual read-path readiness and starts canonical refresh without waiting for its full scan', async () => {
  let records = catalogRows(0);
  useCatalogRows(() => records);
  const refresh = Promise.withResolvers<void>();
  let scans = 0;
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => {
      const host = emptyCollection(dependencies);
      return {
        ...host,
        scan: async (requestId: string) => {
          scans += 1;
          if (scans > 1) {
            await refresh.promise;
          }
          return host.scan(requestId);
        },
      };
    }
  );
  const { activation } = fixture();
  await activation.acquire();
  records = catalogRows(1);
  await activation.acquireRead();
  expect((await activation.getSearchAuthority()).readiness).toContainEqual(
    expect.objectContaining({
      scanComplete: false,
      scope,
    })
  );
  await vi.waitFor(() => expect(scans).toBe(2));
  refresh.resolve();
  await activation.acquire();
  expect(mocks.readyPort().verifyScopedManifest).toBeTypeOf('function');
  expect((await activation.getSearchAuthority()).readiness).toContainEqual(
    expect.objectContaining({
      scanComplete: true,
      scope,
    })
  );
  await activation.close();
});

it('keeps captured cleanup authority through expected source abort and refuses it after writer retirement', async () => {
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation } = fixture();
  await activation.acquire();
  const captured = activation.captureAcknowledgedAuthority();
  const authority = captured.readAuthority();
  await activation.stopSources();
  expect(captured.readAuthority()).toEqual(authority);
  expect(captured.port.info).toBe(mocks.readyPort().info);
  expect(captured.port.coverageBatch).not.toBe(mocks.readyPort().coverageBatch);
  await activation.close();
  expect(() => captured.readAuthority()).toThrow();
});

it('joins retained rooted-row convergence before admitting the replacement writer to reads', async () => {
  const lease: CanonicalWorkspaceLease = {
    canonicalPath: '/actual/root',
    generation: 'actual-generation',
    listDir: unused,
    readFile: unused,
    retire: vi.fn(async () => {}),
    rootId: 'root',
    signal: new AbortController().signal,
    subscribe: unused,
  };
  const application = {
    roots: {
      borrowSourceRoot: vi
        .fn()
        .mockResolvedValueOnce(lease)
        .mockImplementation(async () => ({
          ...lease,
          generation: 'source-borrow',
          retire: async () => {},
        })),
      restoreRoots: async () => [{ permissionState: 'granted', rootId: 'root' }],
    },
    watches: { subscribe: unused },
  } as unknown as ApplicationIpcDomain;
  const records = catalogRows(2).map((record, index) =>
    index === 0 ? { ...record, path: 'file.txt', rootId: 'root' } : record
  );
  setCatalogRoot();
  setCatalogRecords(() => records);
  const removal = Promise.withResolvers<boolean>();
  let retired = false;
  const native = {
    ...writer(),
    removeScopedFile: vi.fn(async () => {
      const removed = await removal.promise;
      retired = true;
      return removed;
    }),
    verifyScopedManifest: vi.fn(
      async (request: Parameters<ScopedIndexerPort['verifyScopedManifest']>[0]) => ({
        authorityEpoch: 'b'.repeat(64),
        authorityRevision: 1,
        changed: [],
        complete: true,
        missing: [],
        scope: requestedScope(request),
        storeId,
        unexpected:
          mocks.acquire.mock.calls.length >= 2 &&
          !retired &&
          requestedScope(request).kind === 'workspace'
            ? [
                {
                  chunks: [],
                  contentHash: 'c'.repeat(64),
                  embeddingSetId: 'selected',
                  fileId: 'retained-0',
                  relativePath: 'file.txt',
                  rootId: 'root',
                  sourcePath: '/actual/root/file.txt',
                },
              ]
            : [],
      })
    ),
  };
  mocks.readyPort.mockReturnValue(native);
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
      const ticket = await dependencies.publication.beginScan({
        requestId: 'workspace',
        scope: { kind: 'workspace', rootId: 'root' },
      });
      dependencies.onReceipt(
        await dependencies.publication.finishScan({
          aborted: false,
          errors: [],
          files: [],
          full: true,
          ticket,
          truncatedDirectories: [],
        })
      );
      return { close: async () => {}, trigger: unused };
    }
  );
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => emptyCollection(dependencies)
  );
  const { activation, storage } = fixture(application);
  await activation.acquire();
  const saved = JSON.parse(await storage.getItem()) as { state: Record<string, unknown> };
  const selected = (await mocks.catalog.collections({ id: 'selected', operation: 'get' }))
    .collections[0];
  if (!selected) {
    throw new Error('Expected selected collection');
  }
  mocks.catalog.collections.mockImplementation(async (request) => ({
    collections:
      request.operation === 'get' && request.id === 'next'
        ? [{ ...selected, id: 'next' }]
        : [selected],
  }));
  saved.state['managedCollectionId'] = 'next';
  storage.getItem.mockResolvedValue(JSON.stringify(saved));
  const changing = activation.reconfigure();
  await vi.waitFor(() => expect(native.removeScopedFile).toHaveBeenCalledOnce());
  expect(native.removeScopedFile).toHaveBeenCalledWith({
    fileId: 'retained-0',
    scope: { kind: 'workspace', rootId: 'root' },
  });
  expect(lease.retire).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
  await expect(activation.acquireRead()).rejects.toThrow('transitioning');
  removal.resolve(true);
  await changing;
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
  expect((await activation.getSearchAuthority()).collectionId).toBe('next');
  await activation.close();
});

it('finishes root plus collection VECTOR startup with reverified receipts and no missing-vector inference', async () => {
  const profile = {
    dimensions: 384,
    distance: 'cosine',
    dtype: 'q8',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    // The catalog row states MiniLM's prompts (none), so the resolved profile carries them.
    prompts: { document: '', query: '' },
    provider: 'transformers',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  } as const;
  const record = {
    ...catalogRows(1)[0],
    chunksProcessed: true,
    content: null,
    contentHash: 'c'.repeat(64),
    embeddingSetId: 'selected',
    fileId: 'rooted-file',
    fileName: 'file.txt',
    path: 'file.txt',
    rootId: 'root',
    stat: { mtimeMs: 1, size: 9 },
  };
  setCatalogRoot();
  setCatalogRecords(() => [record]);
  const lease: CanonicalWorkspaceLease = {
    canonicalPath: '/actual/root',
    generation: 'actual-generation',
    listDir: unused,
    readFile: unused,
    retire: async () => {},
    rootId: 'root',
    signal: new AbortController().signal,
    subscribe: unused,
  };
  const identity = {
    embeddingSetId: 'selected',
    fileId: 'rooted-file',
    fileName: 'file.txt',
    relativePath: 'file.txt',
    rootId: 'root',
    sourcePath: '/actual/root/file.txt',
  };
  const providedChunks = [
    {
      chunkIndex: 0,
      chunkSize: 384,
      chunkType: 'text',
      content: 'canonical',
      contentHash: 'c'.repeat(64),
      endLine: 1,
      endOffset: 9,
      startLine: 1,
      startOffset: 0,
      tokenCount: 2,
    },
  ] as const;
  const plan: ScopedFilePlan = {
    authorityEpoch: 'b'.repeat(64),
    authorityRevision: 1,
    chunks: [
      {
        ...providedChunks[0],
        chunkId: 'd'.repeat(64),
        contentHash: 'c'.repeat(64),
        embeddingHash: 'e'.repeat(64),
      },
    ],
    contentHash: record.contentHash,
    embeddingChunkIds: [],
    previousSnapshotHash: null,
    profile,
    profileHash: vectorProfileHash(profile),
    snapshot: { ...identity, content: 'canonical', providedChunks },
    storeId,
  };
  const native = {
    ...writer(),
    commitScopedFile: vi.fn(async () => ({
      reusedEmbeddings: 1,
      syntaxStatus: 'retained' as const,
      unchanged: true,
      writtenChunks: 0,
      writtenRefs: 0,
      writtenSymbols: 0,
    })),
    coverageScope: vi.fn(async (input: Parameters<ScopedIndexerPort['coverageScope']>[0]) => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      counts: { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 },
      profile,
      profileHash: vectorProfileHash(profile),
      scope: requestedScope(input),
      storeId,
      vectorCoverageComplete: true,
    })),
    prepareScopedFile: vi.fn(async () => plan),
    verifyScopedManifest: vi.fn(
      async (input: Parameters<ScopedIndexerPort['verifyScopedManifest']>[0]) => ({
        authorityEpoch: 'b'.repeat(64),
        authorityRevision: 1,
        changed: [],
        complete: true,
        missing: [],
        scope: requestedScope(input),
        storeId,
        unexpected: [],
      })
    ),
  };
  mocks.readyPort.mockReturnValue(native);
  const publish = async (
    publication: CanonicalVectorPublicationPort,
    target: CanonicalSourceScope
  ): Promise<CanonicalScanReceipt> => {
    const ticket = await publication.beginScan({
      requestId: JSON.stringify(target),
      scope: target,
    });
    const prepared = await publication.prepareVectorFile({
      file: identity,
      payload: { content: 'canonical', fileId: identity.fileId, providedChunks },
      profile,
      ticket,
    });
    await publication.commitVectorFile({
      embeddings: [],
      file: identity,
      plan: prepared,
      profile,
      ticket,
    });
    return publication.finishScan({
      aborted: false,
      errors: [],
      files: [{ ...identity, contentHash: record.contentHash }],
      full: true,
      ticket,
      truncatedDirectories: [],
    });
  };
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
      if (dependencies.mode !== 'VECTOR') {
        throw new Error('Expected explicit VECTOR workspace.');
      }
      dependencies.onReceipt(
        await publish(dependencies.publication, { kind: 'workspace', rootId: 'root' })
      );
      return { close: async () => {}, trigger: unused };
    }
  );
  mocks.manager.attachCanonicalCollection.mockImplementation(
    async (dependencies: CanonicalCollectionDependencies) => {
      if (dependencies.mode !== 'VECTOR') {
        throw new Error('Expected explicit VECTOR collection.');
      }
      return { close: async () => {}, scan: async () => publish(dependencies.publication, scope) };
    }
  );
  const application = {
    roots: {
      borrowSourceRoot: async () => lease,
      restoreRoots: async () => [{ permissionState: 'granted', rootId: 'root' }],
    },
    watches: { subscribe: unused },
  } as unknown as ApplicationIpcDomain;
  const documentEmbeddings = vi.fn(unused);
  const activation = createActivation({
    application,
    embedding: { documentEmbeddings },
    onError: vi.fn(),
    storage: {
      getItem: async () =>
        JSON.stringify({
          state: {
            enabled: true,
            indexingPolicyPreset: 'balanced',
            managedCollectionId: 'selected',
            nativeIndexMode: 'VECTOR',
            nativeLocalSelection: {
              device: 'wasm',
              dimensions: 384,
              dtype: 'q8',
              modelId: profile.modelId,
              revision: profile.revision,
            },
            paused: false,
            worktreeRootIndexingOptInById: {},
          },
        }),
    },
  });
  await activation.acquire();
  expect(activation.getReadiness()).toMatchObject([
    { scanComplete: true, scope: { kind: 'workspace', rootId: 'root' } },
    { scanComplete: true, scope },
  ]);
  expect(documentEmbeddings).not.toHaveBeenCalled();
  expect(native.commitScopedFile).toHaveBeenCalledTimes(2);
  // The opened writer lists the stored rows of its folder and its collection once
  // each (no files declared, BST-1988/BST-2011), then the startup proves three.
  const manifests = vi
    .mocked(native.verifyScopedManifest)
    .mock.calls.map(([input]) => (input as { readonly files: readonly unknown[] }).files.length);
  expect(manifests.filter((declared) => declared === 0)).toHaveLength(2);
  expect(manifests.filter((declared) => declared > 0)).toHaveLength(3);
  expect(native.coverageScope).toHaveBeenCalledTimes(1);
  await activation.close();
});

it('joins physical grep disposal before retiring read authority during a genuine settings replacement', async () => {
  const f = fixture();
  const settings = {
    state: {
      enabled: true,
      indexingPolicyPreset: 'balanced',
      managedCollectionId: 'selected',
      nativeIndexMode: 'TEXT',
      nativeLocalSelection: null,
      paused: true,
      worktreeRootIndexingOptInById: {},
    },
  };
  f.storage.getItem.mockImplementation(async () => JSON.stringify(settings));
  const disposing = Promise.withResolvers<void>();
  const disposed = Promise.withResolvers<void>();
  const close = vi.fn(async () => {
    disposing.resolve();
    await disposed.promise;
  });
  const capability = createNativeScopedSearchCapability({
    openQuery: async () => ({
      close,
      grep: async () => ({
        columns: [
          'id',
          'root_id',
          'file_record_id',
          'path',
          'content',
          'content_hash',
          'start_line',
          'end_line',
          'chunk_index',
          'chunk_size',
          'chunk_type',
          'start_offset',
          'end_offset',
          'token_count',
          'embedding_set_id',
          'source_path',
        ],
        identity: { embedding: { indexMode: 'text-only' as const }, storeId },
        matchedChunks: 0,
        rows: [],
        truncated: false,
      }),
    }),
    rebuild: f.activation.rebuild,
    withRead: f.activation.withRead,
  });
  const pending = capability
    .grep({
      caseSensitive: false,
      collectionId: 'selected',
      isRegex: false,
      limit: 10,
      pattern: 'marker',
      rootIds: [],
    })
    .catch((error: unknown) => error);
  await disposing.promise;
  settings.state.enabled = false;
  const replacing = f.activation.reconfigure().catch((error: unknown) => error);
  await vi.waitFor(() =>
    expect(() => f.activation.captureAcknowledgedAuthority()).toThrow(
      'Native source authority changed'
    )
  );
  expect(mocks.close).not.toHaveBeenCalled();
  disposed.resolve();
  expect(await pending).toBeInstanceOf(Error);
  expect(await replacing).toEqual(new Error('Native indexing is disabled in saved settings.'));
  expect(close).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
  await f.activation.close();
});
