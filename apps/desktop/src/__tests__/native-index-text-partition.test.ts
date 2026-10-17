// @vitest-environment node
/**
 * BST-1988: text search needs no embedding model. Activation in TEXT mode with
 * no saved collection indexes the workspace roots as the TEXT partition: no
 * collection is invented, looked up or attached. VECTOR still requires one.
 */
import type {
  CanonicalWorkspaceLease,
  CanonicalWorkspaceRuntimeDependencies,
} from '@brainstrike/canonical-ingestion';
import type { ScopedIndexerPort } from '@brainstrike/indexer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ApplicationIpcDomain } from '../ipc-handlers';
import { NativeIndexSetupRequiredError } from '../native-index-setup-required';
import {
  createActivation,
  mocks,
  requestedScope,
  resetActivationFixture,
  setCatalogRoot,
  storeId,
  unused,
  writer,
} from './native-index-activation-fixture';

beforeEach(resetActivationFixture);

const workspace = { kind: 'workspace', rootId: 'root' } as const;

function savedSettings(state: Record<string, unknown>) {
  return {
    getItem: async () =>
      JSON.stringify({
        state: {
          enabled: true,
          indexingPolicyPreset: 'balanced',
          nativeLocalSelection: null,
          paused: false,
          worktreeRootIndexingOptInById: {},
          ...state,
        },
      }),
  };
}

function mountedRoot(): ApplicationIpcDomain {
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
  return {
    roots: {
      borrowSourceRoot: async () => lease,
      restoreRoots: async () => [{ permissionState: 'granted', rootId: 'root' }],
    },
    watches: { subscribe: unused },
  } as unknown as ApplicationIpcDomain;
}

it('activates TEXT with no collection as its workspace roots alone', async () => {
  setCatalogRoot();
  const native = {
    ...writer(),
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
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
      const ticket = await dependencies.publication.beginScan({
        requestId: 'text-partition-scan',
        scope: workspace,
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
  const activation = createActivation({
    application: mountedRoot(),
    embedding: { destroyAndRestart: vi.fn(unused), documentEmbeddings: vi.fn(unused) },
    onError: vi.fn(),
    storage: savedSettings({ managedCollectionId: null, nativeIndexMode: 'TEXT' }),
  });
  try {
    await activation.acquire();

    expect(mocks.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ rootIds: ['root'], scopes: [workspace] }),
      expect.anything()
    );
    expect(mocks.manager.attachCanonicalWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ managedCollectionId: null, mode: 'TEXT' })
    );
    expect(mocks.manager.attachCanonicalCollection).not.toHaveBeenCalled();
    expect(mocks.catalog.collections).not.toHaveBeenCalled();
    const catalogReads = mocks.catalog.sourceCatalog.mock.calls.map(([request]) => request);
    expect(catalogReads.length).toBeGreaterThan(0);
    expect(
      catalogReads.every(
        (request) => request.operation === 'inventory' && request.embeddingSetId === null
      )
    ).toBe(true);
    expect(activation.getReadiness()).toEqual([
      expect.objectContaining({ scanComplete: true, scope: workspace }),
    ]);
  } finally {
    await activation.close();
  }
});

it('still asks for a model and collection before VECTOR indexing', async () => {
  const activation = createActivation({
    application: mountedRoot(),
    embedding: { destroyAndRestart: vi.fn(unused), documentEmbeddings: vi.fn(unused) },
    onError: vi.fn(),
    storage: savedSettings({ managedCollectionId: null, nativeIndexMode: 'VECTOR' }),
  });
  try {
    const failure = await activation.acquire().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NativeIndexSetupRequiredError);
    expect(failure).toHaveProperty(
      'message',
      'Choose an embedding model and collection in Search & Indexing settings.'
    );
    expect(mocks.manager.attachCanonicalWorkspace).not.toHaveBeenCalled();
  } finally {
    await activation.close();
  }
});

it('routes explicit workspace scans to the existing admitted trigger and refuses unknown or retired roots', async () => {
  setCatalogRoot();
  const completion = Promise.withResolvers<void>();
  const trigger = vi.fn(() => completion.promise);
  mocks.readyPort.mockReturnValue({
    ...writer(),
    verifyScopedManifest: async (
      request: Parameters<ScopedIndexerPort['verifyScopedManifest']>[0]
    ) => ({
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 1,
      changed: [],
      complete: true,
      missing: [],
      scope: requestedScope(request),
      storeId,
      unexpected: [],
    }),
  });
  mocks.manager.attachCanonicalWorkspace.mockImplementation(
    async (dependencies: CanonicalWorkspaceRuntimeDependencies) => {
      const ticket = await dependencies.publication.beginScan({
        requestId: 'initial',
        scope: workspace,
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
      return { close: async () => {}, trigger };
    }
  );
  const activation = createActivation({
    application: mountedRoot(),
    embedding: { destroyAndRestart: vi.fn(unused), documentEmbeddings: vi.fn(unused) },
    onError: vi.fn(),
    storage: savedSettings({ managedCollectionId: null, nativeIndexMode: 'TEXT' }),
  });
  try {
    await activation.acquire();
    await expect(activation.requestWorkspaceScan('unknown')).rejects.toThrow();
    expect(trigger).not.toHaveBeenCalled();
    let settled = false;
    const requested = activation.requestWorkspaceScan('root').then(() => {
      settled = true;
    });
    expect(trigger).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(settled).toBe(false);
    completion.resolve();
    await requested;
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(mocks.manager.attachCanonicalWorkspace).toHaveBeenCalledOnce();
  } finally {
    completion.resolve();
    await activation.close();
  }
  await expect(activation.requestWorkspaceScan('root')).rejects.toThrow();
  expect(trigger).toHaveBeenCalledOnce();
});

it('refuses explicit workspace scans while source admission is paused', async () => {
  setCatalogRoot();
  const activation = createActivation({
    application: mountedRoot(),
    embedding: { destroyAndRestart: vi.fn(unused), documentEmbeddings: vi.fn(unused) },
    onError: vi.fn(),
    storage: savedSettings({ managedCollectionId: null, nativeIndexMode: 'TEXT', paused: true }),
  });
  try {
    await activation.acquire();
    await expect(activation.requestWorkspaceScan('root')).rejects.toThrow();
    expect(mocks.manager.attachCanonicalWorkspace).not.toHaveBeenCalled();
  } finally {
    await activation.close();
  }
});
