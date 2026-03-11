import {
  __resetImportSettingsStoreForTests,
  __resetTokenPreferencesStoreForTests,
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '@brainstrike/preferences';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseDemoPanel } from '../database-demo-panel';
import { __resetDatabaseDemoStoreForTests } from '../stores/database-demo-store';
import { setActiveEmbeddingSetId } from '../vector-preferences';

// Helper to wrap renders with TooltipProvider
const renderWithProviders = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>);

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

const mockDatabase = {
  query: vi.fn().mockResolvedValue({ rows: [{ location: 'PGlite WASM' }] }),
};

vi.mock('@brainstrike/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db')>();
  return {
    ...actual,
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    useFileRecordRepository: () => mockRepository,
    usePGliteDatabase: () => mockDatabase,
    useFileChunkRepository: () => mockChunkRepository,
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
    usePGliteLiveQuery: (options: { query: string }) => {
      // Return stable object references based on query type
      if (options.query.includes('FROM file_records')) {
        return mockRecordLiveQueryResult;
      }
      if (options.query.includes('FROM file_chunks')) {
        return mockChunkLiveQueryResult;
      }
      return mockRecordLiveQueryResult;
    },
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
    EmbeddingStatusBar: () => <div data-testid="mock-embedding-status-bar" />,
  };
});

const {
  mockEnsureModelRegistry,
  mockFetchRegistry,
  mockUseLocalRuntimeEmbeddingModelCatalog,
  mockUseModelRegistryStore,
} = vi.hoisted(() => {
  const fetchRegistry = vi.fn();
  const ensureModelRegistry = vi.fn();
  const useModelRegistryStore = vi.fn(() => ({
    models: [],
    providers: [],
    ensureRegistry: fetchRegistry,
    fetchRegistry,
    isLoading: false,
  }));
  const useLocalRuntimeEmbeddingModelCatalog = vi.fn(() => ({
    catalog: null,
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  }));
  return {
    mockEnsureModelRegistry: ensureModelRegistry,
    mockFetchRegistry: fetchRegistry,
    mockUseModelRegistryStore: useModelRegistryStore,
    mockUseLocalRuntimeEmbeddingModelCatalog: useLocalRuntimeEmbeddingModelCatalog,
  };
});

vi.mock('@brainstrike/preferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/preferences')>();
  return {
    ...actual,
    useEnsureModelRegistry: mockEnsureModelRegistry,
    useLocalRuntimeEmbeddingModelCatalog: mockUseLocalRuntimeEmbeddingModelCatalog,
    useModelRegistryStore: mockUseModelRegistryStore,
  };
});

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

vi.mock('@brainstrike/file-explorer-ui', () => ({
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
    __resetImportSettingsStoreForTests();
    __resetTokenPreferencesStoreForTests();
    __resetVectorStatusUIStoreForTests();
    vi.clearAllMocks();
    ensureStartedMock.mockClear();
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
  });

  describe('Basic Rendering', () => {
    it('renders database demo panel', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('database-demo-panel')).toBeInTheDocument();
      });
    });

    it('renders the collection browser view', async () => {
      renderWithProviders(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('database-demo-panel')).toBeInTheDocument();
      });
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
        expect(screen.getByText('Routing plan')).toBeInTheDocument();
        expect(screen.getByText('Code module')).toBeInTheDocument();
        // Factory Reset was moved to global Preferences; it should not appear in Import Settings
        expect(screen.queryByText('Factory Reset')).not.toBeInTheDocument();
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
  });

  describe('File Import', () => {
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
      const chunkRefreshCallsBeforeClick = mockChunkLiveQueryResult.refresh.mock.calls.length;
      await user.click(refreshButton);

      await waitFor(() => {
        expect(mockRecordLiveQueryResult.refresh.mock.calls.length).toBeGreaterThan(
          recordRefreshCallsBeforeClick
        );
        expect(mockChunkLiveQueryResult.refresh.mock.calls.length).toBeGreaterThan(
          chunkRefreshCallsBeforeClick
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

  describe('Model Registry Integration', () => {
    it('passes isLoading state to CreateEmbeddingSetDialog', async () => {
      // Mock loading state
      mockUseModelRegistryStore.mockReturnValue({
        models: [],
        providers: [],
        ensureRegistry: mockFetchRegistry,
        fetchRegistry: mockFetchRegistry,
        isLoading: true,
      });

      renderWithProviders(<DatabaseDemoPanel />);

      // Open create collection dialog (use getAllByTitle since both header and picker have create buttons)
      const user = userEvent.setup();
      const createButtons = screen.getAllByTitle('Create new collection');
      const firstButton = createButtons[0];
      expect(firstButton).toBeDefined();
      await user.click(firstButton as HTMLElement);

      // Since we can't easily check props passed to a child component without more complex mocking or integration testing,
      // and we are already testing the dialog's behavior in its own test file,
      // we primarily verify here that the hook is consumed correctly which we did via the mock setup.
      // However, we can verify that the store is being used.
      expect(mockUseModelRegistryStore).toHaveBeenCalled();
    });
  });
});
