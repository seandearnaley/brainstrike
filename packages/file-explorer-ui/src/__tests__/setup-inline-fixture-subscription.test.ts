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
    clearInlineFixture?: () => Promise<void>;
    isInlineFixtureActive?: () => boolean;
    loadInlineFixture?: () => Promise<FileSystemDirectoryHandle>;
  } = {}
): FileSystemAdapter {
  return {
    requestDirectoryAccess: vi.fn(),
    readDirectory: vi.fn(),
    readFile: vi.fn(),
    exists: vi.fn(),
    loadInlineFixture:
      overrides.loadInlineFixture ?? vi.fn(async () => ({}) as FileSystemDirectoryHandle),
    clearInlineFixture: overrides.clearInlineFixture ?? vi.fn(async () => undefined),
    isInlineFixtureActive: overrides.isInlineFixtureActive ?? vi.fn(() => false),
    ...overrides,
  } as unknown as FileSystemAdapter;
}

function createFixtureStore(initialEnabled: boolean) {
  return createStore<FileExplorerState>()((set) => ({
    ...(DEFAULT_STATE as FileExplorerState),
    currentFolderId: null,
    folderStates: {},
    folderAccessOrder: [],
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
    selectionModel: createEmptySelectionModel(),
    devInlineFixtureEnabled: initialEnabled,
    setDevInlineFixtureEnabled: (value) => set({ devInlineFixtureEnabled: value }),
    setCurrentFolderId: vi.fn(),
    hydrateFolderState: vi.fn(),
    setSelectedFiles: vi.fn(),
    addSelectedFile: vi.fn(),
    removeSelectedFile: vi.fn(),
    toggleSelectedFile: vi.fn(),
    clearSelectedFiles: vi.fn(),
    addMultipleSelectedFiles: vi.fn(),
    removeMultipleSelectedFiles: vi.fn(),
    addMultipleSelectedFilesChunked: vi.fn(),
    setExpandedPaths: vi.fn(),
    toggleDirectoryExpansion: vi.fn(),
    setFilters: vi.fn(),
    setUseRegex: vi.fn(),
    setIncludeProjectTree: vi.fn(),
    setFolderSummaryThreshold: vi.fn(),
    setMaxSelectionCount: vi.fn(),
    setLastActiveTab: vi.fn(),
    expandAllDirectories: vi.fn(),
    collapseAllDirectories: vi.fn(),
    setFileContent: vi.fn(),
    clearFileContents: vi.fn(),
    clearAllFileContents: vi.fn(),
    setQuickFilter: vi.fn(),
    clearQuickFilter: vi.fn(),
    setIsAccessLoading: vi.fn(),
    setFiltersExpanded: vi.fn(),
    setSelectionMode: vi.fn(),
    setSelectionRules: vi.fn(),
    setMaterializedRuleSelection: vi.fn(),
    commitRulesToExplicit: vi.fn(),
    setQuerySelection: vi.fn(),
    setQuerySelectionManifest: vi.fn(),
    setViewFilterPresetId: vi.fn(),
    addFilter: vi.fn(),
    removeFilter: vi.fn(),
    toggleFilterEnabled: vi.fn(),
  }));
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
      loadInlineFixture: vi.fn(async () => {
        throw new Error('fixture failed');
      }),
      isInlineFixtureActive: () => false,
    });
    const store = createFixtureStore(true);

    store.setState({
      setDevInlineFixtureEnabled: () => {
        throw new Error('rollback exploded');
      },
    });

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);
    await Promise.resolve();
    await Promise.resolve();

    expect(loggerMocks.warn).toHaveBeenCalledWith('Failed to toggle inline fixture', {
      error: expect.any(Error),
      enabled: true,
    });
    expect(loggerMocks.error).toHaveBeenCalledWith(
      'Inline fixture toggle crashed outside guarded flow',
      {
        error: expect.any(Error),
        enabled: true,
      }
    );

    unsubscribe();
  });

  it('suppresses the rollback subscription bounce when fixture activation fails', async () => {
    const clearInlineFixture = vi.fn(async () => undefined);
    const adapter = createFixtureCapableAdapter({
      loadInlineFixture: vi.fn(async () => {
        throw new Error('fixture failed');
      }),
      clearInlineFixture,
      isInlineFixtureActive: () => false,
    });
    const store = createFixtureStore(true);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);
    await Promise.resolve();
    await Promise.resolve();

    expect(clearInlineFixture).not.toHaveBeenCalled();
    expect(store.getState().devInlineFixtureEnabled).toBe(false);

    unsubscribe();
  });

  it('skips setup when the adapter is not fixture-capable', () => {
    const adapter = {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      exists: vi.fn(),
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
      loadInlineFixture,
      clearInlineFixture,
      isInlineFixtureActive: () => false,
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

  it('exposes a read-only indexing debug snapshot through the global testing API', async () => {
    const adapter = createFixtureCapableAdapter();
    const store = createFixtureStore(false);
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'root-1',
            path: '/workspace/root',
            display_name: 'root',
            kind: 'path',
            status: 'live',
            created_at: '2026-06-16T00:00:00.000Z',
            last_verified_at: '2026-06-16T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            embedding_set_id: 'set-1',
            file_count: 2,
            chunk_count: 4,
            embedded_chunk_count: 1,
            pending_chunk_count: 3,
            dirty: false,
            last_refreshed_at: '2026-06-16T00:01:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            queue: 'embeddings',
            job_type: 'embed_chunk',
            state: 'queued',
            count: 3,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            embedding_set_id: 'set-1',
            root_id: 'root-1',
            file_count: 2,
            oldest_updated_at: '2026-06-16T00:02:00.000Z',
          },
        ],
      });
    window.electronAPI = {
      db: { query },
    } as unknown as NonNullable<Window['electronAPI']>;
    const debugWindow = window as TestWindowWithRuntimeHosts;
    debugWindow.chunkingHost = {
      getStatus: vi.fn(async () => ({
        runtimeKind: 'chunking-host',
        runtimeId: 'chunking-host:test',
        state: 'running',
        active: false,
        lastError: null,
      })),
    };
    debugWindow.embeddingHost = {
      getStatus: vi.fn(async () => ({
        runtimeKind: 'embedding-host',
        runtimeId: 'embedding-host:test',
        state: 'running',
        active: true,
        lastError: null,
      })),
    };

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);

    expect(window.__BRAINSTRIKE_INDEXING_DEBUG__).toBeDefined();
    expect(Object.isFrozen(window.__BRAINSTRIKE_INDEXING_DEBUG__)).toBe(true);

    const snapshot = await window.__BRAINSTRIKE_INDEXING_DEBUG__?.snapshot();

    expect(snapshot).toEqual({
      roots: [
        {
          id: 'root-1',
          path: '/workspace/root',
          display_name: 'root',
          kind: 'path',
          status: 'live',
          created_at: '2026-06-16T00:00:00.000Z',
          last_verified_at: '2026-06-16T00:00:00.000Z',
        },
      ],
      collectionStats: [
        {
          embedding_set_id: 'set-1',
          file_count: 2,
          chunk_count: 4,
          embedded_chunk_count: 1,
          pending_chunk_count: 3,
          dirty: false,
          last_refreshed_at: '2026-06-16T00:01:00.000Z',
        },
      ],
      queueCounts: [
        {
          queue: 'embeddings',
          job_type: 'embed_chunk',
          state: 'queued',
          count: 3,
        },
      ],
      chunkingBacklog: [
        {
          embedding_set_id: 'set-1',
          root_id: 'root-1',
          file_count: 2,
          oldest_updated_at: '2026-06-16T00:02:00.000Z',
        },
      ],
      hosts: {
        chunking: {
          available: true,
          status: {
            runtimeKind: 'chunking-host',
            runtimeId: 'chunking-host:test',
            state: 'running',
            active: false,
            lastError: null,
          },
        },
        embedding: {
          available: true,
          status: {
            runtimeKind: 'embedding-host',
            runtimeId: 'embedding-host:test',
            state: 'running',
            active: true,
            lastError: null,
          },
        },
      },
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
      roots: [],
      collectionStats: [],
      queueCounts: [],
      chunkingBacklog: [],
      hosts: {
        chunking: { available: false, reason: 'chunkingHost bridge unavailable' },
        embedding: { available: false, reason: 'embeddingHost bridge unavailable' },
      },
      accessIssues: [
        {
          source: 'electronAPI.db.query',
          reason: 'database bridge unavailable',
        },
      ],
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
      loadInlineFixture,
      isInlineFixtureActive: () => true,
    });
    const store = createFixtureStore(true);

    const unsubscribe = setupInlineFixtureSubscription(store, adapter);
    await Promise.resolve();

    expect(loadInlineFixture).not.toHaveBeenCalled();
    unsubscribe();
  });
});
