import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { FileExplorerState } from '@brainstrike/types';
import { createEmptySelectionModel, DEFAULT_STATE } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { INJECT_ROOT_HANDLE_EVENT, type InjectRootHandleDetail } from '../inject-root-handle-event';
import { setupInlineFixtureSubscription } from '../setup-inline-fixture-subscription';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

interface TestRuntimeHostBridge {
  getStatus: () => Promise<unknown>;
}

type TestWindowWithRuntimeHosts = Window & {
  chunkingHost?: TestRuntimeHostBridge;
  embeddingHost?: TestRuntimeHostBridge;
};

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: () => loggerMocks,
  };
});

function createFixtureCapableAdapter(
  overrides: Partial<FileSystemAdapter> & {
    addInlineFixtureRoot?: () => Promise<FileSystemDirectoryHandle>;
    clearInlineFixture?: () => Promise<void>;
    isInlineFixtureActive?: () => boolean;
    loadInlineFixture?: () => Promise<FileSystemDirectoryHandle>;
  } = {}
): FileSystemAdapter {
  return {
    addInlineFixtureRoot:
      overrides.addInlineFixtureRoot ?? vi.fn(async () => ({}) as FileSystemDirectoryHandle),
    clearInlineFixture: overrides.clearInlineFixture ?? vi.fn(async () => undefined),
    exists: vi.fn(),
    isInlineFixtureActive: overrides.isInlineFixtureActive ?? vi.fn(() => false),
    loadInlineFixture:
      overrides.loadInlineFixture ?? vi.fn(async () => ({}) as FileSystemDirectoryHandle),
    readDirectory: vi.fn(),
    readFile: vi.fn(),
    requestDirectoryAccess: vi.fn(),
    ...overrides,
  } as unknown as FileSystemAdapter;
}

function createFixtureStore(initialEnabled: boolean) {
  return createStore<FileExplorerState>()((set) => ({
    ...(DEFAULT_STATE as FileExplorerState),
    addFilter: vi.fn(),
    addMultipleSelectedFiles: vi.fn(),
    addMultipleSelectedFilesChunked: vi.fn(),
    addSelectedFile: vi.fn(),
    clearAllFileContents: vi.fn(),
    clearFileContents: vi.fn(),
    clearQuickFilter: vi.fn(),
    clearSelectedFiles: vi.fn(),
    collapseAllDirectories: vi.fn(),
    currentFolderId: null,
    devInlineFixtureEnabled: initialEnabled,
    expandAllDirectories: vi.fn(),
    expandedDirectoryPaths: new Set<string>(),
    folderAccessOrder: [],
    folderStates: {},
    hydrateFolderState: vi.fn(),
    removeFilter: vi.fn(),
    removeMultipleSelectedFiles: vi.fn(),
    removeSelectedFile: vi.fn(),
    selectedFilePaths: new Set<string>(),
    selectionModel: createEmptySelectionModel(),
    setCurrentFolderId: vi.fn(),
    setDevInlineFixtureEnabled: (value) => set({ devInlineFixtureEnabled: value }),
    setExpandedPaths: vi.fn(),
    setFileContent: vi.fn(),
    setFilters: vi.fn(),
    setFiltersExpanded: vi.fn(),
    setFolderSummaryThreshold: vi.fn(),
    setIncludeProjectTree: vi.fn(),
    setIsAccessLoading: vi.fn(),
    setLastActiveTab: vi.fn(),
    setMaterializedRuleSelection: vi.fn(),
    setMaxSelectionCount: vi.fn(),
    setQuerySelection: vi.fn(),
    setQuerySelectionManifest: vi.fn(),
    setQuickFilter: vi.fn(),
    setSelectedFiles: vi.fn(),
    setSelectionMode: vi.fn(),
    setUseRegex: vi.fn(),
    setViewFilterPresetId: vi.fn(),
    toggleDirectoryExpansion: vi.fn(),
    toggleFilterEnabled: vi.fn(),
    toggleSelectedFile: vi.fn(),
  }));
}

/**
 * Wrap a vanilla fixture store with a controllable Zustand persist API so a
 * test can drive the ASYNC hydration ordering the real store exhibits (its
 * persist `getItem` returns a Promise, so hydration completes AFTER
 * useEffect-time setup). The store starts at the pre-hydration default
 * (`false`); `finishHydration` later installs the persisted value and fires the
 * `onFinishHydration` listeners exactly once — the edge-triggered contract the
 * production persist middleware honors.
 */
function createHydratingFixtureStore(persistedEnabled: boolean) {
  const store = createFixtureStore(false);
  let hydrated = false;
  const finishListeners = new Set<() => void>();
  const persist = {
    hasHydrated: () => hydrated,
    onFinishHydration: (callback: () => void) => {
      finishListeners.add(callback);
      return () => {
        finishListeners.delete(callback);
      };
    },
  };
  (store as unknown as { persist: typeof persist }).persist = persist;

  const finishHydration = (): void => {
    // The persist merge installs the persisted flag, THEN listeners fire.
    store.setState({ devInlineFixtureEnabled: persistedEnabled });
    hydrated = true;
    for (const callback of Array.from(finishListeners)) {
      callback();
    }
  };

  return { finishHydration, store };
}

describe('setup-inline-fixture-subscription', () => {
  beforeEach(() => {
    import.meta.env.DEV = true;
    (import.meta.env as ImportMetaEnv & { VITEST?: boolean }).VITEST = true;
    window.__brainstrike_e2e_expose_file_explorer_store__ = undefined;
    window.__BRAINSTRIKE_LOAD_FIXTURE__ = undefined;
    window.__BRAINSTRIKE_CLEAR_FIXTURE__ = undefined;
    window.__BRAINSTRIKE_INDEXING_DEBUG__ = undefined;
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: undefined,
    });
    loggerMocks.debug.mockReset();
    loggerMocks.error.mockReset();
    loggerMocks.info.mockReset();
    loggerMocks.warn.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    import.meta.env.DEV = true;
    import.meta.env.MODE = 'test';
    (import.meta.env as ImportMetaEnv & { VITEST?: boolean }).VITEST = true;
    window.__brainstrike_e2e_expose_file_explorer_store__ = undefined;
    window.__BRAINSTRIKE_LOAD_FIXTURE__ = undefined;
    window.__BRAINSTRIKE_CLEAR_FIXTURE__ = undefined;
    window.__BRAINSTRIKE_INDEXING_DEBUG__ = undefined;
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: undefined,
    });
  });

  it('logs and contains rollback failures instead of leaking an unhandled rejection', async () => {
    const adapter = createFixtureCapableAdapter({
      isInlineFixtureActive: () => false,
      loadInlineFixture: vi.fn(async () => {
        throw new Error('fixture failed');
      }),
    });
    const store = createFixtureStore(false);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);
    store.setState({
      setDevInlineFixtureEnabled: () => {
        throw new Error('rollback exploded');
      },
    });

    // In-session enable (boot no longer auto-applies a persisted flag).
    store.setState({ devInlineFixtureEnabled: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(loggerMocks.warn).toHaveBeenCalledWith('Failed to toggle inline fixture', {
      enabled: true,
      error: expect.any(Error),
    });
    expect(loggerMocks.error).toHaveBeenCalledWith(
      'Inline fixture toggle crashed outside guarded flow',
      {
        enabled: true,
        error: expect.any(Error),
      }
    );

    unsubscribe();
  });

  it('suppresses the rollback subscription bounce when fixture activation fails', async () => {
    const clearInlineFixture = vi.fn(async () => undefined);
    const adapter = createFixtureCapableAdapter({
      clearInlineFixture,
      isInlineFixtureActive: () => false,
      loadInlineFixture: vi.fn(async () => {
        throw new Error('fixture failed');
      }),
    });
    const store = createFixtureStore(false);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);
    // In-session enable (boot no longer auto-applies a persisted flag).
    store.setState({ devInlineFixtureEnabled: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(clearInlineFixture).not.toHaveBeenCalled();
    expect(store.getState().devInlineFixtureEnabled).toBe(false);

    unsubscribe();
  });

  it('skips setup when the adapter is not fixture-capable', () => {
    const adapter = {
      exists: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;
    const store = createFixtureStore(false);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);

    expect(loggerMocks.debug).toHaveBeenCalledWith(
      'Adapter does not support inline fixtures, skipping subscription'
    );
    unsubscribe();
  });

  it('loads and clears the inline fixture through the global testing API', async () => {
    const loadInlineFixture = vi.fn(
      async () => ({ path: '/fixture' }) as unknown as FileSystemDirectoryHandle
    );
    const clearInlineFixture = vi.fn(async () => undefined);
    const adapter = createFixtureCapableAdapter({
      clearInlineFixture,
      isInlineFixtureActive: () => false,
      loadInlineFixture,
    });
    const store = createFixtureStore(false);

    // The subscription now dispatches brainstrike:inject-root-handle (the reducer
    // is the render source of truth); it no longer writes the store handle.
    const injected: InjectRootHandleDetail['handle'][] = [];
    const onInject = (e: Event): void => {
      injected.push((e as CustomEvent<InjectRootHandleDetail>).detail.handle);
    };
    window.addEventListener(INJECT_ROOT_HANDLE_EVENT, onInject);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);
    window.__BRAINSTRIKE_LOAD_FIXTURE__?.({
      name: 'custom-fixture',
      tree: { 'hello.txt': 'world' },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(loadInlineFixture).toHaveBeenCalledTimes(1);
    expect(loadInlineFixture).toHaveBeenCalledWith({
      name: 'custom-fixture',
      tree: { 'hello.txt': 'world' },
    });
    expect(injected.at(-1)).toMatchObject({ path: '/fixture' });
    expect(loggerMocks.info).toHaveBeenCalledWith('Inline fixture loaded');

    window.__BRAINSTRIKE_CLEAR_FIXTURE__?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(clearInlineFixture).toHaveBeenCalledTimes(1);
    expect(injected.at(-1)).toBeNull();
    expect(loggerMocks.info).toHaveBeenCalledWith('Inline fixture cleared');

    window.removeEventListener(INJECT_ROOT_HANDLE_EVENT, onInject);
    unsubscribe();
    expect(window.__BRAINSTRIKE_LOAD_FIXTURE__).toBeUndefined();
    expect(window.__BRAINSTRIKE_CLEAR_FIXTURE__).toBeUndefined();
  });

  it('rejects adding a fixture root while a fixture load is in flight (no silent drop)', async () => {
    // An in-flight loadInlineFixture reassigns the adapter's fixture list; an
    // interleaved add would be silently dropped. The add API must share the
    // load/clear re-entrancy guard and fail loudly instead.
    let resolveLoad: ((handle: FileSystemDirectoryHandle) => void) | undefined;
    const loadInlineFixture = vi.fn(
      () =>
        new Promise<FileSystemDirectoryHandle>((resolve) => {
          resolveLoad = resolve;
        })
    );
    const addInlineFixtureRoot = vi.fn(
      async () => ({ path: '/second-root' }) as unknown as FileSystemDirectoryHandle
    );
    const adapter = createFixtureCapableAdapter({
      addInlineFixtureRoot,
      isInlineFixtureActive: () => false,
      loadInlineFixture,
    });
    const store = createFixtureStore(false);
    const unsubscribe = setupInlineFixtureSubscription(store, adapter);

    const loadPromise = window.__BRAINSTRIKE_LOAD_FIXTURE__?.({
      name: 'primary',
      tree: { 'a.txt': 'a' },
    });

    await expect(
      window.__BRAINSTRIKE_ADD_FIXTURE_ROOT__?.({ name: 'second-root', tree: { 'b.txt': 'b' } })
    ).rejects.toThrow(/load or clear is in flight/);
    expect(addInlineFixtureRoot).not.toHaveBeenCalled();

    resolveLoad?.({ path: '/fixture' } as unknown as FileSystemDirectoryHandle);
    await loadPromise;

    // Once the load settles, adding works.
    await expect(
      window.__BRAINSTRIKE_ADD_FIXTURE_ROOT__?.({ name: 'second-root', tree: { 'b.txt': 'b' } })
    ).resolves.toMatchObject({ path: '/second-root' });
    expect(addInlineFixtureRoot).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(window.__BRAINSTRIKE_ADD_FIXTURE_ROOT__).toBeUndefined();
  });

  it('exposes a read-only indexing debug snapshot through the global testing API', async () => {
    const adapter = createFixtureCapableAdapter();
    const store = createFixtureStore(false);
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            created_at: '2026-06-16T00:00:00.000Z',
            display_name: 'root',
            id: 'root-1',
            kind: 'path',
            last_verified_at: '2026-06-16T00:00:00.000Z',
            path: '/workspace/root',
            status: 'live',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            chunk_count: 4,
            dirty: false,
            embedded_chunk_count: 1,
            embedding_set_id: 'set-1',
            file_count: 2,
            last_refreshed_at: '2026-06-16T00:01:00.000Z',
            pending_chunk_count: 3,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            count: 3,
            job_type: 'embed_chunk',
            queue: 'embeddings',
            state: 'queued',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            embedding_set_id: 'set-1',
            file_count: 2,
            oldest_updated_at: '2026-06-16T00:02:00.000Z',
            root_id: 'root-1',
          },
        ],
      });
    window.electronAPI = {
      db: { query },
    } as unknown as NonNullable<Window['electronAPI']>;
    const debugWindow = window as TestWindowWithRuntimeHosts;
    debugWindow.chunkingHost = {
      getStatus: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'chunking-host:test',
        runtimeKind: 'chunking-host',
        state: 'running',
      })),
    };
    debugWindow.embeddingHost = {
      getStatus: vi.fn(async () => ({
        active: true,
        lastError: null,
        runtimeId: 'embedding-host:test',
        runtimeKind: 'embedding-host',
        state: 'running',
      })),
    };

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);

    expect(window.__BRAINSTRIKE_INDEXING_DEBUG__).toBeDefined();
    expect(Object.isFrozen(window.__BRAINSTRIKE_INDEXING_DEBUG__)).toBe(true);

    const snapshot = await window.__BRAINSTRIKE_INDEXING_DEBUG__?.snapshot();

    expect(snapshot).toEqual({
      chunkingBacklog: [
        {
          embedding_set_id: 'set-1',
          file_count: 2,
          oldest_updated_at: '2026-06-16T00:02:00.000Z',
          root_id: 'root-1',
        },
      ],
      collectionStats: [
        {
          chunk_count: 4,
          dirty: false,
          embedded_chunk_count: 1,
          embedding_set_id: 'set-1',
          file_count: 2,
          last_refreshed_at: '2026-06-16T00:01:00.000Z',
          pending_chunk_count: 3,
        },
      ],
      hosts: {
        chunking: {
          available: true,
          status: {
            active: false,
            lastError: null,
            runtimeId: 'chunking-host:test',
            runtimeKind: 'chunking-host',
            state: 'running',
          },
        },
        embedding: {
          available: true,
          status: {
            active: true,
            lastError: null,
            runtimeId: 'embedding-host:test',
            runtimeKind: 'embedding-host',
            state: 'running',
          },
        },
      },
      queueCounts: [
        {
          count: 3,
          job_type: 'embed_chunk',
          queue: 'embeddings',
          state: 'queued',
        },
      ],
      roots: [
        {
          created_at: '2026-06-16T00:00:00.000Z',
          display_name: 'root',
          id: 'root-1',
          kind: 'path',
          last_verified_at: '2026-06-16T00:00:00.000Z',
          path: '/workspace/root',
          status: 'live',
        },
      ],
    });
    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT id, path, display_name, kind, status, created_at, last_verified_at FROM roots ORDER BY created_at ASC',
      []
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      'SELECT embedding_set_id, file_count, chunk_count, embedded_chunk_count, pending_chunk_count, dirty, last_refreshed_at FROM collection_indexing_stats ORDER BY last_refreshed_at DESC',
      []
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      "SELECT queue, job_type, state, COUNT(*)::int AS count FROM job_queue WHERE job_type = 'embed_chunk' GROUP BY queue, job_type, state ORDER BY queue, job_type, state",
      []
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      'SELECT embedding_set_id, root_id, COUNT(*)::int AS file_count, MIN(updated_at) AS oldest_updated_at FROM file_records WHERE embedding_set_id IS NOT NULL AND root_id IS NOT NULL AND chunks_processed_at IS NULL GROUP BY embedding_set_id, root_id ORDER BY embedding_set_id, root_id',
      []
    );

    unsubscribe();
    expect(window.__BRAINSTRIKE_INDEXING_DEBUG__).toBeUndefined();
    Reflect.deleteProperty(window, 'electronAPI');
    Reflect.deleteProperty(debugWindow, 'chunkingHost');
    Reflect.deleteProperty(debugWindow, 'embeddingHost');
  });

  it('reports unavailable indexing debug dependencies explicitly', async () => {
    const adapter = createFixtureCapableAdapter();
    const store = createFixtureStore(false);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);

    const snapshot = await window.__BRAINSTRIKE_INDEXING_DEBUG__?.snapshot();

    expect(snapshot).toEqual({
      accessIssues: [
        {
          reason: 'database bridge unavailable',
          source: 'electronAPI.db.query',
        },
      ],
      chunkingBacklog: [],
      collectionStats: [],
      hosts: {
        chunking: { available: false, reason: 'chunkingHost bridge unavailable' },
        embedding: { available: false, reason: 'embeddingHost bridge unavailable' },
      },
      queueCounts: [],
      roots: [],
    });

    unsubscribe();
  });

  it('does not expose fixture globals outside dev and test mode', () => {
    import.meta.env.DEV = false;
    import.meta.env.MODE = 'production';
    (import.meta.env as ImportMetaEnv & { VITEST?: boolean }).VITEST = false;
    vi.stubEnv('NODE_ENV', 'production');

    const adapter = createFixtureCapableAdapter();
    const store = createFixtureStore(false);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);

    expect(window.__BRAINSTRIKE_LOAD_FIXTURE__).toBeUndefined();
    expect(window.__BRAINSTRIKE_CLEAR_FIXTURE__).toBeUndefined();
    expect(window.__BRAINSTRIKE_INDEXING_DEBUG__).toBeUndefined();

    unsubscribe();
  });

  it('exposes fixture globals in production only when the explicit E2E flag is present', () => {
    import.meta.env.DEV = false;
    import.meta.env.MODE = 'production';
    (import.meta.env as ImportMetaEnv & { VITEST?: boolean }).VITEST = false;
    vi.stubEnv('NODE_ENV', 'production');
    window.__brainstrike_e2e_expose_file_explorer_store__ = true;
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: true,
    });

    const adapter = createFixtureCapableAdapter();
    const store = createFixtureStore(false);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);

    expect(window.__BRAINSTRIKE_LOAD_FIXTURE__).toBeTypeOf('function');
    expect(window.__BRAINSTRIKE_CLEAR_FIXTURE__).toBeTypeOf('function');
    expect(window.__BRAINSTRIKE_INDEXING_DEBUG__).toBeDefined();

    unsubscribe();
    window.__brainstrike_e2e_expose_file_explorer_store__ = undefined;
  });

  it('keeps fixture globals hidden in production when page code sets the flag without webdriver control', () => {
    import.meta.env.DEV = false;
    import.meta.env.MODE = 'production';
    (import.meta.env as ImportMetaEnv & { VITEST?: boolean }).VITEST = false;
    vi.stubEnv('NODE_ENV', 'production');
    window.__brainstrike_e2e_expose_file_explorer_store__ = true;
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      value: false,
    });

    const adapter = createFixtureCapableAdapter();
    const store = createFixtureStore(false);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);

    expect(window.__BRAINSTRIKE_LOAD_FIXTURE__).toBeUndefined();
    expect(window.__BRAINSTRIKE_CLEAR_FIXTURE__).toBeUndefined();
    expect(window.__BRAINSTRIKE_INDEXING_DEBUG__).toBeUndefined();

    unsubscribe();
    window.__brainstrike_e2e_expose_file_explorer_store__ = undefined;
  });

  it('does not reapply the fixture when persisted state says enabled but the adapter is already active', async () => {
    const loadInlineFixture = vi.fn(async () => ({}) as FileSystemDirectoryHandle);
    const adapter = createFixtureCapableAdapter({
      isInlineFixtureActive: () => true,
      loadInlineFixture,
    });
    const store = createFixtureStore(true);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);
    await Promise.resolve();

    expect(loadInlineFixture).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('resets a persisted enabled flag at startup instead of replacing the workspace', async () => {
    // Fixture injection routes through mode 'replace' (drops other roots). A
    // PERSISTED enable therefore silently swapped the user's restored
    // workspace for the mock fixture on every boot — "my roots don't
    // persist". The flag must reset at startup; enabling is per-session.
    const loadInlineFixture = vi.fn(async () => ({}) as FileSystemDirectoryHandle);
    const adapter = createFixtureCapableAdapter({
      isInlineFixtureActive: () => false,
      loadInlineFixture,
    });
    const store = createFixtureStore(true);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);
    await Promise.resolve();

    expect(loadInlineFixture).not.toHaveBeenCalled();
    expect(store.getState().devInlineFixtureEnabled).toBe(false);

    // An explicit toggle THIS session still works.
    store.getState().setDevInlineFixtureEnabled(true);
    await Promise.resolve();
    expect(loadInlineFixture).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('defers the resurrection guard until persist hydration completes (async worker-backed storage)', async () => {
    // Regression: with the async worker-backed persist storage, hydration
    // completes AFTER useEffect-time setup. If the guard/subscription arm
    // synchronously, the baseline reads the pre-hydration default (false), the
    // guard is a no-op, and the hydration-driven false→true flip is mistaken
    // for a user toggle — loading the fixture in mode 'replace' and dropping
    // the user's restored roots. Arming must be deferred until hydration.
    const loadInlineFixture = vi.fn(async () => ({}) as FileSystemDirectoryHandle);
    const adapter = createFixtureCapableAdapter({
      isInlineFixtureActive: () => false,
      loadInlineFixture,
    });
    const { store, finishHydration } = createHydratingFixtureStore(true);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);

    // Pre-hydration: nothing is armed, so the not-yet-hydrated flag cannot
    // trigger a load, and the guard has not touched state.
    expect(loadInlineFixture).not.toHaveBeenCalled();
    expect(store.getState().devInlineFixtureEnabled).toBe(false);

    // Hydration installs the persisted `true`, then notifies finish listeners.
    finishHydration();
    await Promise.resolve();

    // The guard fires post-hydration: the flag resets and — crucially — the
    // fixture is NEVER loaded in mode 'replace'.
    expect(loadInlineFixture).not.toHaveBeenCalled();
    expect(store.getState().devInlineFixtureEnabled).toBe(false);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'Inline fixture was enabled in persisted state — resetting to keep the restored workspace; re-enable it from settings for this session'
    );

    // A genuine in-session toggle AFTER hydration still applies.
    store.getState().setDevInlineFixtureEnabled(true);
    await Promise.resolve();
    expect(loadInlineFixture).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('arms a post-hydration in-session toggle when the persisted flag was disabled', async () => {
    // The common cold-boot case: nothing persisted enabled. Deferred arming
    // must still wire the subscription so a later toggle loads the fixture.
    const loadInlineFixture = vi.fn(async () => ({}) as FileSystemDirectoryHandle);
    const adapter = createFixtureCapableAdapter({
      isInlineFixtureActive: () => false,
      loadInlineFixture,
    });
    const { store, finishHydration } = createHydratingFixtureStore(false);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);
    finishHydration();
    await Promise.resolve();

    // No persisted enable → guard silent, no reset warning.
    expect(loggerMocks.warn).not.toHaveBeenCalled();
    expect(loadInlineFixture).not.toHaveBeenCalled();

    store.getState().setDevInlineFixtureEnabled(true);
    await Promise.resolve();
    expect(loadInlineFixture).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('does not arm the subscription when disposed before hydration finishes', async () => {
    // HMR/unmount can tear the setup down before the async hydration resolves.
    // A late onFinishHydration must not arm a subscription on a dead setup.
    const loadInlineFixture = vi.fn(async () => ({}) as FileSystemDirectoryHandle);
    const adapter = createFixtureCapableAdapter({
      isInlineFixtureActive: () => false,
      loadInlineFixture,
    });
    const { store, finishHydration } = createHydratingFixtureStore(true);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);
    // Dispose BEFORE hydration completes.
    unsubscribe();

    finishHydration();
    await Promise.resolve();

    // Guard never ran (no reset), and no post-dispose toggle can reach a load.
    expect(store.getState().devInlineFixtureEnabled).toBe(true);
    store.getState().setDevInlineFixtureEnabled(false);
    store.getState().setDevInlineFixtureEnabled(true);
    await Promise.resolve();
    expect(loadInlineFixture).not.toHaveBeenCalled();
  });
});
