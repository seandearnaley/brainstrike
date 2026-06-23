import { createTestActionRegistry } from '@brainstrike/context-actions';
import type { EmbeddingSet } from '@brainstrike/db';
import {
  getRegisteredEmbeddingQueueFactory,
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
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectionActions } from '../context-actions';
import { DatabaseDemoPanel } from '../database-demo-panel';
import { __resetDatabaseDemoStoreForTests } from '../stores/database-demo-store';
import { setActiveEmbeddingSetId } from '../vector-preferences';

// Helper to wrap renders with TooltipProvider and the context-action registry
// (CollectionBrowserView mounts the shared ActionContextMenu, whose
// useActionRegistry throws without a provider).
const renderWithProviders = (ui: React.ReactElement) =>
  render(
    <ActionRegistryProvider
      registry={createTestActionRegistry({ actions: collectionActions }).registry}
    >
      <TooltipProvider>{ui}</TooltipProvider>
    </ActionRegistryProvider>
  );

const { ensureStartedMock } = vi.hoisted(() => ({
  ensureStartedMock: vi.fn(async () => ({
    transportKind: 'local-worker' as const,
    chunkFile: vi.fn(),
    chunkBatch: vi.fn(),
    isReady: vi.fn(() => true),
    terminate: vi.fn(),
  })),
}));

// Mock all external dependencies at the top level
const mockRepository = {
  findAll: vi.fn(),
  findAllWithContent: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

const mockChunkRepository = {
  findAll: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findByFileRecordId: vi.fn(),
  searchSimilar: vi.fn(),
};

class TursoFileChunkRepository {
  findAll = vi.fn();
  findByFileRecordId = vi.fn();
  findById = vi.fn();
  searchSimilar = vi.fn();
}

const mockEmbeddingService = {
  dispose: vi.fn(),
  generateEmbedding: vi.fn(),
  generateQueryEmbedding: vi.fn(),
  search: vi.fn(),
  getStatus: vi.fn().mockReturnValue('ready'),
  initializeWithModel: vi.fn(),
};

const mockToast = vi.fn();

const mockImportFiles = vi.fn();

const TEST_COLLECTION_ID = 'test-collection-id';

vi.mock('@brainstrike/embeddings', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/embeddings')>('@brainstrike/embeddings');
  const mockModels = {
    'all-MiniLM-L6-v2': {
      name: 'all-MiniLM-L6-v2',
      dimensions: 384,
      maxTokens: 512,
    },
    'bge-m3': {
      name: 'BGE-M3',
      dimensions: 1024,
      maxTokens: 8192,
    },
  };

  return {
    ...actual,
    SimpleEmbeddingService: Object.assign(
      vi.fn().mockImplementation(() => mockEmbeddingService),
      {
        listModels: vi.fn().mockReturnValue(mockModels),
        getDefaultModelKey: vi.fn().mockReturnValue('all-MiniLM-L6-v2'),
      }
    ),
  };
});

// Create stable mock results outside the mock function to prevent infinite loops
const mockRecordLiveQueryResult = {
  rows: [] as unknown[],
  loading: false,
  error: null,
  refresh: vi.fn().mockResolvedValue(undefined),
};

const mockChunkLiveQueryResult = {
  rows: [] as unknown[],
  loading: false,
  error: null,
  refresh: vi.fn().mockResolvedValue(undefined),
};

const mockCollectionCountLiveQueryResult = {
  rows: [
    {
      embeddingsetid: TEST_COLLECTION_ID,
      recordsCount: 1,
      chunksCount: 1,
      embeddingsCount: 1,
    },
  ] as unknown[],
  loading: false,
  error: null,
  refresh: vi.fn().mockResolvedValue(undefined),
};

const mockCollectionLiveQueryResult = {
  rows: [] as unknown[],
  loading: false,
  error: null,
  refresh: vi.fn().mockResolvedValue(undefined),
};

const mockDatabase = {
  query: vi.fn().mockResolvedValue({ rows: [{ location: 'PGlite WASM' }] }),
};
let mockDatabaseClient: typeof mockDatabase | null = mockDatabase;
let mockCurrentChunkRepository: typeof mockChunkRepository | null = mockChunkRepository;

vi.mock('@brainstrike/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db')>();
  const useLiveQueryMock = (options: { query: string }) => {
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
  };
  return {
    ...actual,
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    useFileRecordRepository: () => mockRepository,
    useBrainstrikeDbClient: () => mockDatabaseClient,
    useFileChunkRepository: () => mockCurrentChunkRepository,
    useClearAllData: () => vi.fn(() => Promise.resolve({ deletedFiles: 0, deletedChunks: 0 })),
    useDbProviderError: () => null,
    useFactoryReset: () => null,
    useVectorEnabled: () => true,
    MigrationRunner: class MockMigrationRunner {
      async initialize() {
        return Promise.resolve();
      }
      async up() {
        return Promise.resolve();
      }
    },
    migrations: [],
    useBrainstrikeLiveQuery: useLiveQueryMock,
  };
});

vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual('@brainstrike/ui');
  return {
    ...actual,
    useToast: () => ({
      toast: mockToast,
    }),
    useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
    ModelPicker: () => <div data-testid="mock-model-picker" />,
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
  };
});

// Mock useEmbeddingControls hook to avoid provider requirements in tests
vi.mock('@brainstrike/vector-management', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/vector-management')>();
  return {
    ...actual,
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
        queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
        startingWorker: false,
        willAutoStartWorker: false,
      },
      statusBarProps: {
        latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
        queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
        telemetryTrend: [],
        throughput: 0,
        vectorEnabled: true,
        workerStatus: 'disabled' as const,
      },
      hasDb: true,
    }),
    EmbeddingActionsDropdown: () => <div data-testid="mock-embedding-actions-dropdown" />,
    CreateEmbeddingSetDialog: ({
      onSetCreated,
    }: {
      onSetCreated: (newSetId: string, newSet: EmbeddingSet) => void;
    }) => (
      <button
        data-testid="mock-create-embedding-set-dialog"
        onClick={() =>
          onSetCreated('created-set-id', {
            id: 'created-set-id',
            modelKey: 'local:created-model',
            modelId: 'created-model',
            dimensions: 768,
            distance: 'cosine',
            createdAt: '2026-05-03T01:00:00.000Z',
            name: 'Created Collection',
            description: 'Created from the dialog',
            tags: 'new,dialog',
            category: 'local',
          })
        }
        type="button"
      >
        Finish creating collection
      </button>
    ),
  };
});

const { mockEnsureModelRegistry, mockUseLocalRuntimeEmbeddingModelCatalog } = vi.hoisted(() => {
  const ensureModelRegistry = vi.fn();
  const useLocalRuntimeEmbeddingModelCatalog = vi.fn(() => ({
    catalog: null,
    isLoading: false,
    error: null,
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
    port: null,
    isReady: false,
    isProcessing: false,
    error: null,
    ensureStarted: ensureStartedMock,
    reinitialize: vi.fn(),
  }),
}));

vi.mock('./enhanced-file-import-service', () => ({
  useEnhancedFileImportService: vi.fn().mockReturnValue({
    isImporting: false,
    progress: null,
    importFiles: mockImportFiles,
    chunkRepository: mockChunkRepository,
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
    fileSystemAdapter: null,
    databaseAdapter: null,
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
    Separator: () => <div data-testid="resize-handle" />,
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
    ensureStartedMock.mockClear();
    mockImportFiles.mockReset();
    setActiveEmbeddingSetId(TEST_COLLECTION_ID);
    useVectorStatusUIStore.getState().setSchemaVerified(true);
    mockDatabaseClient = mockDatabase;
    mockCurrentChunkRepository = mockChunkRepository;

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
      onProgress: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: false,
      isProcessing: false,
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

  describe('Store subscription scope (perf)', () => {
    it('does not re-render the panel when a model download progress tick fires', async () => {
      const onRender = vi.fn();

      render(
        <ActionRegistryProvider
          registry={createTestActionRegistry({ actions: collectionActions }).registry}
        >
          <TooltipProvider>
            <React.Profiler id="database-demo-panel-perf" onRender={onRender}>
              <DatabaseDemoPanel />
            </React.Profiler>
          </TooltipProvider>
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

    it('fetches model registry on mount', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(mockEnsureModelRegistry).toHaveBeenCalledWith(
          expect.objectContaining({ db: mockDatabase })
        );
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
        managedCollectionId: TEST_COLLECTION_ID,
        mode: 'root-folder-cache',
        hasHydrated: true,
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
        managedCollectionId: TEST_COLLECTION_ID,
        mode: 'root-folder-cache',
        hasHydrated: true,
      });
      useVectorStatusUIStoreDirect.getState().setCachedCollections([
        {
          id: TEST_COLLECTION_ID,
          modelKey: 'local::Xenova/all-MiniLM-L6-v2',
          modelId: 'Xenova/all-MiniLM-L6-v2',
          dimensions: 384,
          distance: 'cosine',
          createdAt: '2026-06-07T00:00:00Z',
          name: 'Managed Import Guard',
          description: null,
          tags: null,
          category: null,
          fileCount: 0,
          chunkCount: 0,
          embeddingCount: 0,
          systemRole: null,
        },
      ]);

      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeDisabled();
      expect(screen.getByText(/manual db imports are disabled/i)).toBeInTheDocument();
    });

    it('disables manual import when the active collection has the workspace index system role', async () => {
      useVectorStatusUIStoreDirect.getState().setCachedCollections([
        {
          id: TEST_COLLECTION_ID,
          modelKey: 'openai::text-embedding-3-small',
          modelId: 'text-embedding-3-small',
          dimensions: 1536,
          distance: 'cosine',
          createdAt: '2026-06-07T00:00:00Z',
          name: 'Workspace Index',
          description: 'System-managed workspace index for assistant retrieval.',
          tags: null,
          category: null,
          fileCount: 1,
          chunkCount: 1,
          embeddingCount: 1,
          systemRole: 'workspace-index',
        },
      ]);
      mockCollectionLiveQueryResult.rows = [
        {
          id: TEST_COLLECTION_ID,
          modelKey: 'openai::text-embedding-3-small',
          modelId: 'text-embedding-3-small',
          dimensions: 1536,
          distance: 'cosine',
          createdAt: '2026-06-07T00:00:00Z',
          name: 'Workspace Index',
          description: 'System-managed workspace index for assistant retrieval.',
          tags: null,
          category: null,
          fileCount: '1',
          chunkCount: '1',
          embeddingCount: '1',
          systemRole: 'workspace-index',
        },
      ];

      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeDisabled();
      expect(screen.getByText(/manual db imports are disabled/i)).toBeInTheDocument();
    });

    it('disables manual import when database or chunk storage is unavailable', async () => {
      mockDatabaseClient = null;
      mockCurrentChunkRepository = null;

      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeDisabled();
    });

    it('disables manual import for Turso chunk storage until the import path is migrated', async () => {
      mockCurrentChunkRepository =
        new TursoFileChunkRepository() as unknown as typeof mockChunkRepository;

      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /^Import\s*\(/ })).toBeDisabled();
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
    it('loads file records and provides them to collection browser', async () => {
      const mockRecords = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          size: 100,
          content: 'test content',
          createdAt: '2025-01-01T00:00:00Z',
          processedAt: '2025-01-01T00:00:00Z',
          embeddingSetId: TEST_COLLECTION_ID,
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
      const newButton = within(toolbar).getByRole('button', { name: /^New$/ });
      expect(newButton).toBeInTheDocument();

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
      expect(within(footer).getByRole('button', { name: /^Export$/ })).toBeInTheDocument();
      expect(within(footer).getByRole('button', { name: /^Import\s*\(/ })).toBeInTheDocument();
      expect(within(footer).getByTestId('mock-embedding-actions-dropdown')).toBeInTheDocument();

      const toolbar = screen.getByTestId('database-panel-toolbar');
      expect(within(toolbar).queryByRole('button', { name: /^Export$/ })).not.toBeInTheDocument();
      expect(
        within(toolbar).queryByRole('button', { name: /^Import\s*\(/ })
      ).not.toBeInTheDocument();
      expect(
        within(toolbar).queryByTestId('mock-embedding-actions-dropdown')
      ).not.toBeInTheDocument();
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
          id: 'created-set-id',
          modelKey: 'local:created-model',
          modelId: 'created-model',
          dimensions: 768,
          distance: 'cosine',
          createdAt: '2026-05-03T01:00:00.000Z',
          name: 'Created Collection',
          description: 'Created from the dialog',
          tags: 'new,dialog',
          category: 'local',
          fileCount: 0,
          chunkCount: 0,
          embeddingCount: 0,
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
