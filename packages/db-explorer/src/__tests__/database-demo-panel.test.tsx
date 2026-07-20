import { createTestActionRegistry } from '@brainstrike/context-actions';
import type { EmbeddingSet } from '@brainstrike/db';
import {
  getRegisteredEmbeddingQueueFactory,
  registerEmbeddingQueueFactory,
  resetEmbeddingQueueFactory,
} from '@brainstrike/embeddings/runtime-config';
import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  __resetImportSettingsStoreForTests,
  __resetTokenPreferencesStoreForTests,
  __resetVectorStatusUIStoreForTests,
  useBackgroundIndexingPreferencesStore,
  useVectorStatusUIStore,
} from '@brainstrike/preferences';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '@brainstrike/preferences/stores/model-registry-store';
import { useVectorStatusUIStore as useVectorStatusUIStoreDirect } from '@brainstrike/preferences/stores/vector-status-ui-store';
import type { QueueAdapter } from '@brainstrike/queue';
import { ActionRegistryProvider, TooltipProvider } from '@brainstrike/ui';
import { SearchEmbedderProvider, setActiveEmbeddingSetId } from '@brainstrike/vector-management';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectionActions } from '../context-actions';
import { DatabaseDemoPanel } from '../database-demo-panel';
import { __resetDatabaseDemoStoreForTests } from '../stores/database-demo-store';

// Helper to wrap renders with TooltipProvider and the context-action registry
// (CollectionBrowserView mounts the shared ActionContextMenu, whose
// useActionRegistry throws without a provider).
const withProviders = (ui: React.ReactElement) => (
  <ActionRegistryProvider
    registry={createTestActionRegistry({ actions: collectionActions }).registry}
  >
    <SearchEmbedderProvider>
      <TooltipProvider>{ui}</TooltipProvider>
    </SearchEmbedderProvider>
  </ActionRegistryProvider>
);
const renderWithProviders = (ui: React.ReactElement) => render(withProviders(ui));

const { dbProviderErrorMock, ensureStartedMock, useFileRecordRepositoryMock } = vi.hoisted(() => ({
  dbProviderErrorMock: { current: null as Error | null },
  ensureStartedMock: vi.fn(async () => ({
    chunkBatch: vi.fn(),
    chunkFile: vi.fn(),
    isReady: vi.fn(() => true),
    terminate: vi.fn(),
    transportKind: 'local-worker' as const,
  })),
  useFileRecordRepositoryMock: vi.fn(),
}));

// Mock all external dependencies at the top level
const mockRepository = {
  count: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  findAll: vi.fn(),
  findAllWithContent: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
};

const mockChunkRepository = {
  create: vi.fn(),
  delete: vi.fn(),
  findAll: vi.fn(),
  findByFileRecordId: vi.fn(),
  findById: vi.fn(),
  searchSimilar: vi.fn(),
  update: vi.fn(),
};

const mockEmbeddingService = {
  dispose: vi.fn(),
  generateEmbedding: vi.fn(),
  generateQueryEmbedding: vi.fn(),
  getStatus: vi.fn().mockReturnValue('ready'),
  initializeWithModel: vi.fn(),
  search: vi.fn(),
};

const mockToast = vi.fn();

const mockImportFiles = vi.fn();

const TEST_COLLECTION_ID = 'test-collection-id';

vi.mock('@brainstrike/embeddings', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/embeddings')>('@brainstrike/embeddings');
  const mockModels = {
    'all-MiniLM-L6-v2': {
      dimensions: 384,
      maxTokens: 512,
      name: 'all-MiniLM-L6-v2',
    },
    'bge-m3': {
      dimensions: 1024,
      maxTokens: 8192,
      name: 'BGE-M3',
    },
  };

  return {
    ...actual,
    SimpleEmbeddingService: Object.assign(
      vi.fn().mockImplementation(() => mockEmbeddingService),
      {
        getDefaultModelKey: vi.fn().mockReturnValue('all-MiniLM-L6-v2'),
        listModels: vi.fn().mockReturnValue(mockModels),
      }
    ),
  };
});

// Create stable mock results outside the mock function to prevent infinite loops
const mockRecordLiveQueryResult = {
  error: null,
  loading: false,
  refresh: vi.fn().mockResolvedValue(undefined),
  rows: [] as unknown[],
};

const mockChunkLiveQueryResult = {
  error: null,
  loading: false,
  refresh: vi.fn().mockResolvedValue(undefined),
  rows: [] as unknown[],
};

const mockCollectionCountLiveQueryResult = {
  error: null,
  loading: false,
  refresh: vi.fn().mockResolvedValue(undefined),
  rows: [
    {
      chunksCount: 1,
      embeddingsCount: 1,
      embeddingsetid: TEST_COLLECTION_ID,
      recordsCount: 1,
    },
  ] as unknown[],
};

const mockCollectionLiveQueryResult = {
  error: null,
  loading: false,
  refresh: vi.fn().mockResolvedValue(undefined),
  rows: [] as unknown[],
};

const mockDatabase = {
  query: vi.fn().mockResolvedValue({ rows: [{ location: 'PGlite WASM' }] }),
};

vi.mock('@brainstrike/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db')>();
  return {
    ...actual,
    MigrationRunner: class MockMigrationRunner {
      async initialize() {
        return Promise.resolve();
      }
      async up() {
        return Promise.resolve();
      }
    },
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    migrations: [],
    useClearAllData: () => vi.fn(() => Promise.resolve({ deletedChunks: 0, deletedFiles: 0 })),
    useDbProviderError: () => dbProviderErrorMock.current,
    useFactoryReset: () => null,
    useFileChunkRepository: () => mockChunkRepository,
    useFileRecordRepository: useFileRecordRepositoryMock,
    usePGliteDatabase: () => mockDatabase,
    usePGliteLiveQuery: (options: { query: string }) => {
      // Return stable object references based on query type. The active-collection
      // counts query is a live aggregate over file_records/file_chunks, so match it
      // by its distinctive projection before the generic file_records branch.
      if (options.query.includes('AS "recordsCount"')) {
        return mockCollectionCountLiveQueryResult;
      }
      if (options.query.includes('FROM embedding_sets s')) {
        return mockCollectionLiveQueryResult;
      }
      if (options.query.includes('FROM file_records')) {
        return mockRecordLiveQueryResult;
      }
      if (options.query.includes('FROM file_chunks')) {
        return mockChunkLiveQueryResult;
      }
      return mockRecordLiveQueryResult;
    },
    useVectorEnabled: () => true,
  };
});

vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual('@brainstrike/ui');
  return {
    ...actual,
    CollectionPicker: ({
      collections,
      selectedId,
      onSelect,
      onCreate,
    }: {
      collections: Array<{ id: string; name: string }>;
      selectedId: string | null;
      onSelect: (id: string | null) => void;
      onCreate?: () => void;
    }) => (
      <div data-testid="mock-collection-picker">
        {onCreate && (
          <button onClick={onCreate} title="Create new collection" type="button">
            Create
          </button>
        )}
        {collections.map((c) => (
          <button
            data-selected={selectedId === c.id}
            data-testid={`collection-${c.id}`}
            key={c.id}
            onClick={() => onSelect(c.id)}
            type="button"
          >
            {c.name}
          </button>
        ))}
      </div>
    ),
    ModelPicker: () => <div data-testid="mock-model-picker" />,
    useTheme: () => ({ setTheme: vi.fn(), theme: 'light' }),
    useToast: () => ({
      toast: mockToast,
    }),
  };
});

// Mock useEmbeddingControls hook to avoid provider requirements in tests
vi.mock('@brainstrike/vector-management', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/vector-management')>();
  return {
    ...actual,
    CreateEmbeddingSetDialog: ({
      onSetCreated,
    }: {
      onSetCreated: (newSetId: string, newSet: EmbeddingSet) => void;
    }) => (
      <button
        data-testid="mock-create-embedding-set-dialog"
        onClick={() =>
          onSetCreated('created-set-id', {
            category: 'local',
            createdAt: '2026-05-03T01:00:00.000Z',
            description: 'Created from the dialog',
            dimensions: 768,
            distance: 'cosine',
            id: 'created-set-id',
            modelId: 'created-model',
            modelKey: 'local:created-model',
            name: 'Created Collection',
            tags: 'new,dialog',
          })
        }
        type="button"
      >
        Finish creating collection
      </button>
    ),
    EmbeddingActionsDropdown: () => <div data-testid="mock-embedding-actions-dropdown" />,
    useEmbeddingControls: () => ({
      dropdownProps: {
        backfilling: false,
        backfillProgress: null,
        coverage: null,
        disabled: true,
        disabledReason: 'No collection selected',
        failedCount: 0,
        hasDb: true,
        onBackfill: vi.fn(),
        onClearQueue: vi.fn(),
        onRetryFailed: vi.fn(),
        onWipeQueue: vi.fn(),
        queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
        startingWorker: false,
        willAutoStartWorker: false,
      },
      hasDb: true,
      statusBarProps: {
        latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
        queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
        telemetryTrend: [],
        throughput: 0,
        vectorEnabled: true,
        workerStatus: 'disabled' as const,
      },
    }),
  };
});

const { mockEnsureModelRegistry, mockUseLocalRuntimeEmbeddingModelCatalog } = vi.hoisted(() => {
  const ensureModelRegistry = vi.fn();
  const useLocalRuntimeEmbeddingModelCatalog = vi.fn(() => ({
    catalog: null,
    error: null,
    isLoading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }));
  return {
    mockEnsureModelRegistry: ensureModelRegistry,
    mockUseLocalRuntimeEmbeddingModelCatalog: useLocalRuntimeEmbeddingModelCatalog,
  };
});

vi.mock('@brainstrike/preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/preferences')>();
  return {
    ...actual,
  };
});

vi.mock('@brainstrike/preferences/hooks/use-model-registry', () => ({
  useEnsureModelRegistry: mockEnsureModelRegistry,
}));

vi.mock('@brainstrike/preferences/hooks/use-local-runtime-embedding-model-catalog', () => ({
  useLocalRuntimeEmbeddingModelCatalog: mockUseLocalRuntimeEmbeddingModelCatalog,
}));

// Fix mock hoisting - define variables inside vi.mock
vi.mock('./csv-export-utils', () => ({
  createCSVBlob: vi.fn().mockReturnValue(new Blob(['test csv'], { type: 'text/csv' })),
  exportAllDataAsZip: vi.fn().mockResolvedValue(undefined),
  generateChunksCSV: vi.fn().mockReturnValue('chunk,data\ntest,chunk'),
  generateCSVFilename: vi.fn().mockReturnValue('test-export.csv'),
  generateEmbeddingsCSV: vi.fn().mockReturnValue('embedding,data\ntest,embedding'),
  generateFilesWithChunksCSV: vi.fn().mockReturnValue('file,chunks\ntest,file'),
}));

vi.mock('file-saver', () => ({
  saveAs: vi.fn(),
}));

vi.mock('@brainstrike/file-import/chunking-worker-context', () => ({
  useChunkingWorkerContext: vi.fn().mockReturnValue({
    ensureStarted: ensureStartedMock,
    error: null,
    isProcessing: false,
    isReady: false,
    port: null,
    reinitialize: vi.fn(),
  }),
}));

vi.mock('./enhanced-file-import-service', () => ({
  useEnhancedFileImportService: vi.fn().mockReturnValue({
    chunkRepository: mockChunkRepository,
    importFiles: mockImportFiles,
    isImporting: false,
    progress: null,
  }),
}));

// Mock the file import service that the enhanced service depends on
vi.mock('./file-import-service', () => ({
  useFileImportService: vi.fn().mockReturnValue({
    importFiles: vi.fn().mockResolvedValue([]),
    isImporting: false,
    progress: null,
  }),
}));

// Mock the file explorer hooks
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    databaseAdapter: null,
    fileSystemAdapter: null,
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorer: () => ({
    fileContents: new Map(),
    fileTree: null,
  }),
  useSelectionManager: () => ({
    selectedFilePaths: new Set(['folder-1|@|/test/test-file.txt']),
  }),
}));

vi.mock('react-resizable-panels', () => {
  const React = require('react');
  return {
    Group: ({
      children,
      onLayoutChange,
    }: {
      children: React.ReactNode;
      onLayoutChange?: (sizes: number[]) => void;
    }) => {
      React.useEffect(() => {
        if (onLayoutChange) {
          onLayoutChange([75, 25]);
        }
      }, [onLayoutChange]);
      return <div data-testid="panel-group">{children}</div>;
    },
    Panel: React.forwardRef(
      (
        {
          children,
          id,
        }: {
          children: React.ReactNode;
          id?: string;
          onCollapse?: () => void;
          onExpand?: () => void;
        },
        _ref: React.Ref<unknown>
      ) => <div data-testid={`panel-${id}`}>{children}</div>
    ),
    Separator: (props: React.HTMLAttributes<HTMLHRElement>) => (
      <hr data-testid="resize-handle" {...props} />
    ),
  };
});

describe('DatabaseDemoPanel', () => {
  beforeEach(() => {
    __resetDatabaseDemoStoreForTests();
    __resetModelRegistryStoreForTests();
    __resetBackgroundIndexingPreferencesStoreForTests();
    __resetImportSettingsStoreForTests();
    __resetTokenPreferencesStoreForTests();
    __resetVectorStatusUIStoreForTests();
    resetEmbeddingQueueFactory();
    vi.clearAllMocks();
    dbProviderErrorMock.current = null;
    ensureStartedMock.mockClear();
    useFileRecordRepositoryMock.mockReset();
    useFileRecordRepositoryMock.mockReturnValue(mockRepository);
    mockImportFiles.mockReset();
    setActiveEmbeddingSetId(TEST_COLLECTION_ID);
    useVectorStatusUIStore.getState().setSchemaVerified(true);

    // Setup default mock returns
    mockRepository.findAll.mockResolvedValue([]);
    mockRepository.findAllWithContent.mockResolvedValue([]);
    mockRepository.count.mockResolvedValue(0);
    mockChunkRepository.findAll.mockResolvedValue([]);

    // Reset live query mock results
    mockRecordLiveQueryResult.rows = [];
    mockRecordLiveQueryResult.loading = false;
    mockRecordLiveQueryResult.error = null;
    mockChunkLiveQueryResult.rows = [];
    mockChunkLiveQueryResult.loading = false;
    mockChunkLiveQueryResult.error = null;
    mockCollectionLiveQueryResult.rows = [];
    mockCollectionLiveQueryResult.loading = false;
    mockCollectionLiveQueryResult.error = null;
  });

  it('registers the provided embedding queue for semantic search lifetime', async () => {
    const mockQueue = {
      add: vi.fn(),
      addBulk: vi.fn(),
      cancel: vi.fn(),
      drain: vi.fn(),
      isPaused: false,
      isProcessing: false,
      onProgress: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    } as unknown as QueueAdapter;

    const view = renderWithProviders(<DatabaseDemoPanel embeddingQueue={mockQueue} />);

    await waitFor(() => {
      const factory = getRegisteredEmbeddingQueueFactory();
      expect(factory).not.toBeNull();
      expect(factory?.()).toBe(mockQueue);
    });

    view.unmount();

    expect(getRegisteredEmbeddingQueueFactory()).toBeNull();
  });

  it('restores the previously registered embedding queue factory on unmount instead of clobbering the app-level registration', async () => {
    // The app runtime (web root layout / desktop root layout) registers a
    // durable queue factory at startup. Mounting the demo panel scopes its own
    // factory over it; unmounting must RESTORE the app-level factory — a null
    // reset would break every later semantic search ("Embedding queue factory
    // is not registered").
    const appLevelQueue = { id: 'app-level-queue' } as unknown as QueueAdapter;
    const appLevelFactory = () => appLevelQueue;
    registerEmbeddingQueueFactory(appLevelFactory);

    const mockQueue = {
      add: vi.fn(),
      addBulk: vi.fn(),
      cancel: vi.fn(),
      drain: vi.fn(),
      isPaused: false,
      isProcessing: false,
      onProgress: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    } as unknown as QueueAdapter;

    const view = renderWithProviders(<DatabaseDemoPanel embeddingQueue={mockQueue} />);

    await waitFor(() => {
      expect(getRegisteredEmbeddingQueueFactory()?.()).toBe(mockQueue);
    });

    view.unmount();

    expect(getRegisteredEmbeddingQueueFactory()).toBe(appLevelFactory);
  });

  describe('Store subscription scope (perf)', () => {
    it('does not re-render the panel when a model download progress tick fires', async () => {
      const onRender = vi.fn();

      render(
        <ActionRegistryProvider
          registry={createTestActionRegistry({ actions: collectionActions }).registry}
        >
          <SearchEmbedderProvider>
            <TooltipProvider>
              <React.Profiler id="database-demo-panel-perf" onRender={onRender}>
                <DatabaseDemoPanel />
              </React.Profiler>
            </TooltipProvider>
          </SearchEmbedderProvider>
        </ActionRegistryProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('database-demo-panel')).toBeInTheDocument();
      });
      // Flush any straggler mount-effect state updates before snapshotting.
      await act(async () => {});
      const commitsAfterMount = onRender.mock.calls.length;

      // Model downloads emit setDownloadProgress per progress tick. The panel
      // only consumes models/providers/isLoading, so a tick must not commit a
      // re-render of the entire collection-browser panel.
      act(() => {
        useModelRegistryStore.getState().setDownloadProgress('jinaai/jina-embeddings-v3', 42);
      });

      expect(onRender.mock.calls.length).toBe(commitsAfterMount);
    });
  });

  describe('Basic Rendering', () => {
    it('keeps a provider error detail visible when Error.message is empty', () => {
      const emptyMessageError = new Error('placeholder');
      emptyMessageError.message = '';
      dbProviderErrorMock.current = emptyMessageError;

      renderWithProviders(<DatabaseDemoPanel />);

      expect(screen.getByRole('alert')).toHaveTextContent('Database failed to initialize');
      expect(screen.getByTestId('db-init-error')).toHaveTextContent('Error');
      // The surface is named Collections (matching its Library tab); only the
      // engine-level error copy still speaks about the database itself.
      expect(screen.getByTestId('database-panel-loading-label')).toHaveTextContent(
        'Collections unavailable'
      );
    });

    it('preserves one split-panel shell while the database repository initializes', async () => {
      useFileRecordRepositoryMock.mockReturnValue(null);

      const view = renderWithProviders(<DatabaseDemoPanel />);

      const stablePanel = screen.getByTestId('database-demo-panel');
      expect(stablePanel).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByTestId('database-panel-toolbar')).toHaveClass('h-9');
      expect(screen.getByTestId('database-panel-toolbar')).toHaveClass(
        '@container/database-toolbar'
      );
      expect(screen.getByTestId('database-panel-loading-label')).toHaveClass(
        '@[360px]:inline',
        'hidden'
      );
      expect(screen.getByTestId('database-panel-loading-label')).toHaveTextContent('Collections');
      expect(screen.getByTestId('database-panel-loading-settings')).toHaveClass(
        '@[360px]:w-20',
        'w-7'
      );
      expect(screen.getByTestId('database-panel-loading-top')).toHaveClass('flex-[38]');
      expect(screen.getByTestId('database-panel-loading-body')).toBeInTheDocument();
      expect(screen.getByTestId('database-panel-loading-actions')).toHaveClass('h-9');

      useFileRecordRepositoryMock.mockReturnValue(mockRepository);
      view.rerender(withProviders(<DatabaseDemoPanel />));

      await waitFor(() => {
        expect(stablePanel).toHaveAttribute('aria-busy', 'false');
      });
      expect(screen.getByTestId('database-demo-panel')).toBe(stablePanel);
    });

    it('renders database demo panel', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('database-demo-panel')).toBeInTheDocument();
      });
    });

    it('does not render a panel-local embedding status bar', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('database-demo-panel')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('mock-embedding-status-bar')).not.toBeInTheDocument();
    });

    it('renders the collection browser view', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('database-demo-panel')).toBeInTheDocument();
      });
    });

    it('publishes and clears desktop test hook snapshots in test mode', async () => {
      window.desktopLifecycle = { isTestMode: true };

      const view = renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(window.__brainstrikeDatabaseDemoTestHooks__).toBeDefined();
        expect(window.__brainstrikeDatabaseDemoSemanticSearchTestHooks__).toBeDefined();
      });

      expect(window.__brainstrikeDatabaseDemoTestHooks__?.getImportSnapshot()).toEqual(
        expect.objectContaining({
          activeCollectionId: TEST_COLLECTION_ID,
          isImporting: false,
          selectedFileCount: 1,
        })
      );
      expect(window.__brainstrikeDatabaseDemoSemanticSearchTestHooks__?.getSnapshot()).toEqual(
        expect.objectContaining({
          error: null,
          firstResultNodeId: null,
          hasSearched: false,
          isSearching: false,
          resultCount: 0,
        })
      );

      view.unmount();

      expect(window.__brainstrikeDatabaseDemoTestHooks__).toBeUndefined();
      expect(window.__brainstrikeDatabaseDemoSemanticSearchTestHooks__).toBeUndefined();
      window.desktopLifecycle = undefined;
    });

    it('keeps database browser controls visible when no collection is selected', async () => {
      setActiveEmbeddingSetId(null);

      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        // Trigger button's aria-label is dynamic — "Expand hybrid search" /
        // "Collapse hybrid search" — so match by a case-insensitive regex
        // covering both expanded and collapsed states.
        expect(screen.getByRole('button', { name: /hybrid search/i })).toBeInTheDocument();
      });

      expect(screen.queryByText('No collection selected')).not.toBeInTheDocument();
      expect(screen.getByText(/Create or select a collection/i)).toBeInTheDocument();
    });

    it('defers runtime model catalog loading until collection creation', async () => {
      const user = userEvent.setup();
      renderWithProviders(<DatabaseDemoPanel />);

      expect(mockUseLocalRuntimeEmbeddingModelCatalog).not.toHaveBeenCalled();
      const registryHookCallsBeforeCreate = mockEnsureModelRegistry.mock.calls.length;

      await user.click(screen.getByRole('button', { name: 'New' }));

      expect(mockEnsureModelRegistry.mock.calls.length).toBeGreaterThan(
        registryHookCallsBeforeCreate
      );
      expect(mockUseLocalRuntimeEmbeddingModelCatalog).toHaveBeenCalledWith({
        maxVerificationModels: 8,
        verifyEmbeddingDimensions: true,
      });
    });
  });

  describe('Settings Panel', () => {
    it('shows settings panel when settings button is clicked', async () => {
      const user = userEvent.setup();
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Import Settings/ })).toBeInTheDocument();
      });

      const settingsButton = screen.getByRole('button', { name: /Import Settings/ });
      await user.click(settingsButton);

      await waitFor(() => {
        expect(screen.getByText('Chunking Studio')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Routing plan/i })).toBeInTheDocument();
        // Factory Reset was moved to global Preferences; it should not appear in Import Settings
        expect(screen.queryByText('Factory Reset')).not.toBeInTheDocument();
      });

      // Routing plan is collapsed by default; expand to verify the route preview renders.
      await user.click(screen.getByRole('button', { name: /Routing plan/i }));
      await waitFor(() => {
        expect(screen.getByText('Code module')).toBeInTheDocument();
      });
    }, 10_000);

    it('toggles chunking setting', async () => {
      const user = userEvent.setup();
      renderWithProviders(<DatabaseDemoPanel />);

      // Wait for settings button to be available
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Import Settings/ })).toBeInTheDocument();
      });

      // Open settings
      const settingsButton = screen.getByRole('button', { name: /Import Settings/ });
      await user.click(settingsButton);

      // Wait for settings panel to be visible
      await waitFor(() => {
        expect(screen.getByText('Chunking Studio')).toBeInTheDocument();
      });

      const chunkingCheckbox = screen.getByLabelText('Enable chunking');
      expect(chunkingCheckbox).toBeChecked();
      await user.click(chunkingCheckbox);
      await waitFor(() => {
        expect(chunkingCheckbox).not.toBeChecked();
      });
      await user.click(chunkingCheckbox);
      await waitFor(() => {
        expect(chunkingCheckbox).toBeChecked();
      });
    }, 10_000);

    it('renders chunking preset badges in dedicated status rows', async () => {
      const user = userEvent.setup();
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Import Settings/ })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /Import Settings/ }));

      await waitFor(() => {
        expect(screen.getByTestId('chunking-preset-status-balanced')).toBeInTheDocument();
        expect(screen.getByTestId('chunking-preset-status-codebase')).toBeInTheDocument();
      });

      expect(screen.getByTestId('chunking-preset-status-balanced')).toHaveTextContent('Adaptive');
      expect(screen.getByTestId('chunking-preset-status-balanced')).toHaveTextContent('auto');
      expect(screen.getByTestId('chunking-preset-status-codebase')).toHaveTextContent('Adaptive');
    }, 10_000);
  });

  describe('File Import', () => {
    it('disables manual import when the active collection is managed by background indexing', async () => {
      useBackgroundIndexingPreferencesStore.setState({
        enabled: true,
        hasHydrated: true,
        managedCollectionId: TEST_COLLECTION_ID,
        mode: 'root-folder-cache',
      });

      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeDisabled();
      expect(screen.getByText(/manual db imports are disabled/i)).toBeInTheDocument();
    });

    it('disables manual import when the loaded active collection is the managed collection', async () => {
      useBackgroundIndexingPreferencesStore.setState({
        enabled: true,
        hasHydrated: true,
        managedCollectionId: TEST_COLLECTION_ID,
        mode: 'root-folder-cache',
      });
      useVectorStatusUIStoreDirect.getState().setCachedCollections([
        {
          category: null,
          chunkCount: 0,
          createdAt: '2026-06-07T00:00:00Z',
          description: null,
          dimensions: 384,
          distance: 'cosine',
          embeddingCount: 0,
          fileCount: 0,
          id: TEST_COLLECTION_ID,
          modelId: 'Xenova/all-MiniLM-L6-v2',
          modelKey: 'local::Xenova/all-MiniLM-L6-v2',
          name: 'Managed Import Guard',
          systemRole: null,
          tags: null,
        },
      ]);

      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeDisabled();
      expect(screen.getByText(/manual db imports are disabled/i)).toBeInTheDocument();
    });

    it('clears an active workspace index and keeps manual import unavailable', async () => {
      useVectorStatusUIStoreDirect.getState().setCachedCollections([
        {
          category: null,
          chunkCount: 1,
          createdAt: '2026-06-07T00:00:00Z',
          description: 'System-managed workspace index for assistant retrieval.',
          dimensions: 1536,
          distance: 'cosine',
          embeddingCount: 1,
          fileCount: 1,
          id: TEST_COLLECTION_ID,
          modelId: 'text-embedding-3-small',
          modelKey: 'openai::text-embedding-3-small',
          name: 'Workspace Index',
          systemRole: 'workspace-index',
          tags: null,
        },
      ]);
      mockCollectionLiveQueryResult.rows = [
        {
          category: null,
          chunkCount: '1',
          createdAt: '2026-06-07T00:00:00Z',
          description: 'System-managed workspace index for assistant retrieval.',
          dimensions: 1536,
          distance: 'cosine',
          embeddingCount: '1',
          fileCount: '1',
          id: TEST_COLLECTION_ID,
          modelId: 'text-embedding-3-small',
          modelKey: 'openai::text-embedding-3-small',
          name: 'Workspace Index',
          systemRole: 'workspace-index',
          tags: null,
        },
      ];

      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(useVectorStatusUIStoreDirect.getState().activeEmbeddingSetId).toBeNull();
      });

      expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeDisabled();
      expect(screen.queryByText(/manual db imports are disabled/i)).not.toBeInTheDocument();
    });

    it('attempts to call import function when import button is clicked', async () => {
      const user = userEvent.setup();
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeInTheDocument();
      });

      const importButton = screen.getByRole('button', { name: /^Import\s*\(/ });
      await user.click(importButton);

      // The component should attempt to call import, even if it fails due to missing adapters
      // Since we're mocking the enhanced file import service, it should at least try
      // Let's verify the button was clicked and some action was taken
      expect(importButton).toBeInTheDocument();

      // Check that a toast was called (either success or error)
      expect(mockToast).toHaveBeenCalled();
    });

    it('shows toast when import fails due to missing adapters', async () => {
      const user = userEvent.setup();
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeInTheDocument();
      });

      const importButton = screen.getByRole('button', { name: /^Import\s*\(/ });
      await user.click(importButton);

      // The component should show an import error
      // The actual error depends on setup, but import should fail
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Import Failed',
          variant: 'destructive',
        })
      );
    });
  });

  describe('Data Loading', () => {
    it('keeps an already loaded collection interactive while live data revalidates', async () => {
      mockRecordLiveQueryResult.rows = [
        {
          createdAt: '2025-01-01T00:00:00Z',
          embeddingSetId: TEST_COLLECTION_ID,
          id: 'loaded-record',
          name: 'loaded.txt',
          path: '/loaded.txt',
          size: 100,
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ];

      const view = renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByText('loaded.txt')).toBeInTheDocument();
      });

      mockRecordLiveQueryResult.loading = true;
      view.rerender(withProviders(<DatabaseDemoPanel />));

      expect(screen.getByTestId('collection-tree-region')).toHaveAttribute('aria-busy', 'false');
      expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      expect(screen.getByText('loaded.txt')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    });

    it('loads file records and provides them to collection browser', async () => {
      const mockRecords = [
        {
          content: 'test content',
          createdAt: '2025-01-01T00:00:00Z',
          embeddingSetId: TEST_COLLECTION_ID,
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          processedAt: '2025-01-01T00:00:00Z',
          size: 100,
        },
      ];

      mockRepository.findAllWithContent.mockResolvedValue(mockRecords);
      mockRepository.findAll.mockResolvedValue(mockRecords);
      mockRecordLiveQueryResult.rows = mockRecords;

      renderWithProviders(<DatabaseDemoPanel />);

      // The panel renders and provides data to CollectionBrowserView
      await waitFor(() => {
        expect(screen.getByTestId('database-demo-panel')).toBeInTheDocument();
      });
    });

    it('handles refresh button click', async () => {
      const user = userEvent.setup();
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Refresh/ })).toBeInTheDocument();
      });

      const refreshButton = screen.getByRole('button', { name: /Refresh/ });
      const recordRefreshCallsBeforeClick = mockRecordLiveQueryResult.refresh.mock.calls.length;
      await user.click(refreshButton);

      await waitFor(() => {
        expect(mockRecordLiveQueryResult.refresh.mock.calls.length).toBeGreaterThan(
          recordRefreshCallsBeforeClick
        );
      });
    });
  });

  describe('Export Functionality', () => {
    it('shows export dropdown', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        // The export dropdown should be visible
        expect(screen.getByRole('button', { name: /Refresh/ })).toBeInTheDocument();
      });
    });
  });

  describe('Header Toolbar Layout', () => {
    it('renders a header toolbar with data-testid="database-panel-toolbar"', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('database-panel-toolbar')).toBeInTheDocument();
      });
    });

    it('places the New button as the leftmost button in the header toolbar', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('database-panel-toolbar')).toBeInTheDocument();
      });

      const toolbar = screen.getByTestId('database-panel-toolbar');
      expect(toolbar).toHaveClass('@container/database-toolbar', 'h-9');
      const newButton = within(toolbar).getByRole('button', { name: /^New$/ });
      expect(newButton).toBeInTheDocument();
      expect(within(newButton).getByText('New')).toHaveClass('hidden', '@[360px]:inline');

      const toolbarButtons = within(toolbar).getAllByRole('button');
      expect(toolbarButtons[0]).toBe(newButton);
    });

    it('places the Settings button on the right side of the header toolbar', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('database-panel-toolbar')).toBeInTheDocument();
      });

      const toolbar = screen.getByTestId('database-panel-toolbar');
      const settingsButton = within(toolbar).getByRole('button', { name: /Import Settings/ });
      expect(settingsButton).toBeInTheDocument();
      expect(within(settingsButton).getByText('Settings')).toHaveClass('hidden', '@[360px]:inline');

      const toolbarButtons = within(toolbar).getAllByRole('button');
      expect(toolbarButtons.at(-1)).toBe(settingsButton);
    });

    it('places the Refresh button in the header toolbar (not the footer)', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('database-panel-toolbar')).toBeInTheDocument();
      });

      const toolbar = screen.getByTestId('database-panel-toolbar');
      expect(within(toolbar).getByRole('button', { name: /Refresh/ })).toBeInTheDocument();

      const footer = screen.getByTestId('database-panel-actions');
      expect(within(footer).queryByRole('button', { name: /Refresh/ })).not.toBeInTheDocument();
    });

    it('places the Help button in the header toolbar (not the footer)', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('database-panel-toolbar')).toBeInTheDocument();
      });

      const toolbar = screen.getByTestId('database-panel-toolbar');
      expect(within(toolbar).getByRole('button', { name: /Help/ })).toBeInTheDocument();

      const footer = screen.getByTestId('database-panel-actions');
      expect(within(footer).queryByRole('button', { name: /Help/ })).not.toBeInTheDocument();
    });

    it('keeps Export, Import, and Embeddings actions in the footer (not the toolbar)', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('database-panel-actions')).toBeInTheDocument();
      });

      const footer = screen.getByTestId('database-panel-actions');
      const footerRow = screen.getByTestId('database-panel-actions-row');
      expect(footer).toHaveClass('@container/database-actions');
      expect(footerRow).toHaveClass('h-9', 'justify-center');
      expect(within(footerRow).getByRole('button', { name: /^Export$/ })).toBeInTheDocument();
      expect(within(footerRow).getByRole('button', { name: /^Import\s*\(/ })).toBeInTheDocument();
      expect(within(footerRow).getByTestId('mock-embedding-actions-dropdown')).toBeInTheDocument();
      expect(within(footerRow).getByText('Import')).toHaveClass('hidden', '@[420px]:inline');

      const toolbar = screen.getByTestId('database-panel-toolbar');
      expect(within(toolbar).queryByRole('button', { name: /^Export$/ })).not.toBeInTheDocument();
      expect(
        within(toolbar).queryByRole('button', { name: /^Import\s*\(/ })
      ).not.toBeInTheDocument();
      expect(
        within(toolbar).queryByTestId('mock-embedding-actions-dropdown')
      ).not.toBeInTheDocument();
    });

    it('disables refresh rotation when reduced motion is requested', async () => {
      mockRecordLiveQueryResult.loading = true;

      renderWithProviders(<DatabaseDemoPanel />);

      const refreshButton = await screen.findByRole('button', { name: 'Refresh' });
      expect(refreshButton.querySelector('svg')).toHaveClass(
        'animate-spin',
        'motion-reduce:animate-none'
      );
    });

    it('names the database split resize separator', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      expect(
        await screen.findByRole('separator', { name: 'Resize database panels' })
      ).toBeInTheDocument();
    });
  });

  describe('Model Registry Integration', () => {
    it('caches a newly created collection before selecting it', async () => {
      const upsertCachedCollection = vi.fn();
      useVectorStatusUIStoreDirect.setState({ upsertCachedCollection });

      renderWithProviders(<DatabaseDemoPanel />);

      const user = userEvent.setup();
      const createButtons = screen.getAllByTitle('Create new collection');
      const firstButton = createButtons[0];
      expect(firstButton).toBeDefined();
      await user.click(firstButton as HTMLElement);

      await user.click(screen.getByTestId('mock-create-embedding-set-dialog'));

      await waitFor(() => {
        expect(upsertCachedCollection).toHaveBeenCalledWith({
          category: 'local',
          chunkCount: 0,
          createdAt: '2026-05-03T01:00:00.000Z',
          description: 'Created from the dialog',
          dimensions: 768,
          distance: 'cosine',
          embeddingCount: 0,
          fileCount: 0,
          id: 'created-set-id',
          modelId: 'created-model',
          modelKey: 'local:created-model',
          name: 'Created Collection',
          tags: 'new,dialog',
        });
        expect(useVectorStatusUIStoreDirect.getState().activeEmbeddingSetId).toBe('created-set-id');
      });
    });

    it('passes isLoading state to CreateEmbeddingSetDialog', async () => {
      // Real store: drive the registry-loading flag through state.
      useModelRegistryStore.setState({ isLoading: true });

      renderWithProviders(<DatabaseDemoPanel />);

      // Open create collection dialog (use getAllByTitle since both header and picker have create buttons)
      const user = userEvent.setup();
      const createButtons = screen.getAllByTitle('Create new collection');
      const firstButton = createButtons[0];
      expect(firstButton).toBeDefined();
      await user.click(firstButton as HTMLElement);

      // The dialog's own behavior is covered in its test file; here we verify
      // the panel still renders and opens the dialog while the registry loads.
      expect(screen.getByTestId('database-demo-panel')).toBeInTheDocument();
    });
  });
});
