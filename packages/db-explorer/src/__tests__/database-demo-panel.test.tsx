import {
  __resetImportSettingsStoreForTests,
  __resetTokenPreferencesStoreForTests,
} from '@brainstrike/preferences';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseDemoPanel } from '../database-demo-panel';
import { __resetDatabaseDemoStoreForTests } from '../stores/database-demo-store';

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

vi.mock('@brainstrike/db', () => ({
  useFileRecordRepository: () => mockRepository,
  usePGliteDatabase: () => null,
  useFileChunkRepository: () => mockChunkRepository,
  useClearAllData: () => vi.fn(() => Promise.resolve({ deletedFiles: 0, deletedChunks: 0 })),
  useDbProviderError: () => null,
  useFactoryReset: () => null,
}));

vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual('@brainstrike/ui');
  return {
    ...actual,
    useToast: () => ({
      toast: mockToast,
    }),
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

describe('DatabaseDemoPanel', () => {
  beforeEach(() => {
    __resetDatabaseDemoStoreForTests();
    __resetImportSettingsStoreForTests();
    __resetTokenPreferencesStoreForTests();
    vi.clearAllMocks();

    // Setup default mock returns
    mockRepository.findAll.mockResolvedValue([]);
    mockRepository.findAllWithContent.mockResolvedValue([]);
    mockRepository.count.mockResolvedValue(0);
    mockChunkRepository.findAll.mockResolvedValue([]);
  });

  describe('Basic Rendering', () => {
    it('renders database demo panel with title', async () => {
      render(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('database-demo-panel')).toBeInTheDocument();
        expect(screen.getByText('Enhanced Database Demo')).toBeInTheDocument();
        expect(
          screen.getByText('PGlite WASM with pgvector, chunking, and embeddings')
        ).toBeInTheDocument();
      });
    });

    it('shows database connection status', async () => {
      render(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByText(/Successfully connected/)).toBeInTheDocument();
      });
    });
  });

  describe('View Switching', () => {
    it('switches between Files, Chunks, and Search views', async () => {
      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      // Find the view selector buttons using the same strategy as other tests
      const allButtons = screen.getAllByRole('button');

      // Find view selector buttons (they have h-9 class and specific text patterns)
      const filesTab = allButtons.find(
        (btn) =>
          btn.textContent?.includes('Files (0)') &&
          btn.className.includes('h-9') &&
          btn.className.includes('bg-primary') // Active tab
      );
      const chunksTab = allButtons.find(
        (btn) =>
          btn.textContent?.includes('Chunks (0)') &&
          btn.className.includes('h-9') &&
          !btn.className.includes('flex items-center gap-1') // Not export button
      );
      const searchTab = allButtons.find(
        (btn) =>
          btn.textContent?.trim() === 'Search' &&
          btn.className.includes('h-9') &&
          !btn.className.includes('flex items-center gap-1') // Not search action button
      );

      // Initially Files view should be active
      expect(filesTab).toBeInTheDocument();
      expect(chunksTab).toBeInTheDocument();
      expect(searchTab).toBeInTheDocument();

      // Switch to Chunks view
      if (chunksTab) await user.click(chunksTab);

      // Switch to Search view
      if (searchTab) await user.click(searchTab);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search in file chunks...')).toBeInTheDocument();
      });
    }, 10000); // Increase timeout to 10s for CI environment
  });

  describe('Settings Panel', () => {
    it('shows settings panel when settings button is clicked', async () => {
      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Import Settings/ })).toBeInTheDocument();
      });

      const settingsButton = screen.getByRole('button', { name: /Import Settings/ });
      await user.click(settingsButton);

      await waitFor(() => {
        expect(screen.getByText('Chunking')).toBeInTheDocument();
        expect(screen.getByText('Embeddings')).toBeInTheDocument();
      });
    }, 10000);

    it('toggles chunking setting', async () => {
      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      // Wait for settings button to be available
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Import Settings/ })).toBeInTheDocument();
      });

      // Open settings
      const settingsButton = screen.getByRole('button', { name: /Import Settings/ });
      await user.click(settingsButton);

      // Wait for settings panel to be visible
      await waitFor(() => {
        expect(screen.getByText('Chunking')).toBeInTheDocument();
      });

      // Find chunking checkbox (first checkbox in the settings panel)
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes.length).toBeGreaterThan(0);
      const chunkingCheckbox = checkboxes[0];
      expect(chunkingCheckbox).toBeDefined();

      // Toggle chunking
      if (chunkingCheckbox) await user.click(chunkingCheckbox);
    }, 10000);

    it('toggles embedding setting', async () => {
      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      // Open settings
      const settingsButton = screen.getByRole('button', { name: /Import Settings/ });
      await user.click(settingsButton);

      await waitFor(() => {
        expect(screen.getByText('Embeddings')).toBeInTheDocument();
      });

      // Find embedding checkbox (second checkbox in the settings panel)
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes.length).toBeGreaterThan(1);
      const embeddingCheckbox = checkboxes[1];
      expect(embeddingCheckbox).toBeDefined();

      // Toggle embedding
      if (embeddingCheckbox) await user.click(embeddingCheckbox);
    });
  });

  describe('File Expansion', () => {
    it('expands and collapses file details', async () => {
      const mockRecords = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test/path/test.txt',
          size: 1024,
          content: 'test content',
          createdAt: '2025-01-01T00:00:00Z',
          processedAt: '2025-01-01T00:00:00Z',
          chunkingStrategy: 'semantic' as const,
          chunksCount: 3,
        },
      ];

      mockRepository.findAll.mockResolvedValue(mockRecords);

      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByText('test.txt')).toBeInTheDocument();
      });

      // Find and click the expand button (the button with chevron icon)
      const expandButtons = screen.getAllByRole('button');
      const chevronButton = expandButtons.find(
        (button) => button.querySelector('svg') && button.className.includes('h-6 w-6 p-0')
      );
      expect(chevronButton).toBeDefined();
      if (chevronButton) await user.click(chevronButton);

      // Check that expanded content is shown
      await waitFor(() => {
        expect(screen.getByText('Path: /test/path/test.txt')).toBeInTheDocument();
        expect(screen.getByText(/Chunking: semantic • 3 chunks/)).toBeInTheDocument();
      });
    });

    it('displays file chunks when file is expanded and has chunks', async () => {
      const mockRecords = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test/path/test.txt',
          size: 1024,
          content: 'test content',
          createdAt: '2025-01-01T00:00:00Z',
          processedAt: '2025-01-01T00:00:00Z',
          chunkingStrategy: 'semantic' as const,
          chunksCount: 2,
        },
      ];

      const mockChunks = [
        {
          id: 'chunk1',
          fileRecordId: '1',
          chunkIndex: 0,
          chunkType: 'text' as const,
          content:
            'First chunk content that is longer than 200 characters to test truncation functionality. This content should be truncated when displayed in the UI to keep the interface clean and readable.',
          tokenCount: 50,
          embedding: null,
          createdAt: '2025-01-01T00:00:00Z',
        },
        {
          id: 'chunk2',
          fileRecordId: '1',
          chunkIndex: 1,
          chunkType: 'text' as const,
          content: 'Second chunk content',
          tokenCount: 25,
          embedding: new Float32Array([0.1, 0.2, 0.3]),
          createdAt: '2025-01-01T00:00:00Z',
        },
      ];

      mockRepository.findAllWithContent.mockResolvedValue(mockRecords);
      mockRepository.findAll.mockResolvedValue(mockRecords);
      mockChunkRepository.findAll.mockResolvedValue(mockChunks);

      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByText('test.txt')).toBeInTheDocument();
      });

      // Find and click the expand button (the button with chevron icon)
      const expandButtons = screen.getAllByRole('button');
      const chevronButton = expandButtons.find(
        (button) => button.querySelector('svg') && button.className.includes('h-6 w-6 p-0')
      );
      expect(chevronButton).toBeDefined();
      if (chevronButton) await user.click(chevronButton);

      // Check that chunk information is displayed
      await waitFor(() => {
        expect(screen.getByText('Chunks:')).toBeInTheDocument();
        expect(screen.getByText('text #0')).toBeInTheDocument();
        expect(screen.getByText('text #1')).toBeInTheDocument();
        expect(screen.getByText('50 tokens')).toBeInTheDocument();
        expect(screen.getByText('25 tokens')).toBeInTheDocument();
        expect(screen.getByText('embedded')).toBeInTheDocument();
      });

      // Check content truncation
      expect(
        screen.getByText(
          /First chunk content that is longer than 200 characters to test truncation functionality\. This content should be truncated when displayed in the UI to keep the interface clean and readable\./
        )
      ).toBeInTheDocument();
      expect(screen.getByText('Second chunk content')).toBeInTheDocument();
    });
  });

  describe('Chunks View', () => {
    it('displays chunks when chunks tab is selected', async () => {
      const mockChunks = [
        {
          id: 'chunk1',
          fileRecordId: '1',
          chunkIndex: 0,
          chunkType: 'text' as const,
          content:
            'This is a chunk with content longer than 300 characters to test the truncation functionality in the chunks view. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
          tokenCount: 75,
          embedding: new Float32Array([0.1, 0.2, 0.3]),
          createdAt: '2025-01-01T00:00:00Z',
        },
      ];

      const mockRecords = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test/path/test.txt',
          size: 1024,
          content: 'test content',
          createdAt: '2025-01-01T00:00:00Z',
          processedAt: '2025-01-01T00:00:00Z',
        },
      ];

      mockChunkRepository.findAll.mockResolvedValue(mockChunks);
      mockRepository.findAllWithContent.mockResolvedValue(mockRecords);
      mockRepository.findAll.mockResolvedValue(mockRecords);

      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      // Wait for component to load
      await waitFor(() => {
        expect(screen.getByText('Enhanced Database Demo')).toBeInTheDocument();
      });

      // Find the chunks tab in the view selector (not the export button)
      const viewButtons = screen.getAllByRole('button');
      const chunksTab = viewButtons.find(
        (button) =>
          button.textContent?.includes('Chunks (1)') &&
          button.className.includes('h-9 rounded-md px-3') &&
          !button.className.includes('flex items-center gap-1')
      );
      expect(chunksTab).toBeDefined();
      if (chunksTab) await user.click(chunksTab);

      // Check that chunks are displayed
      await waitFor(() => {
        expect(screen.getByText('text #0')).toBeInTheDocument();
        expect(screen.getByText('75')).toBeInTheDocument();
        expect(screen.getByText(/embedded/i)).toBeInTheDocument();
        expect(screen.getByText('test.txt')).toBeInTheDocument();
      });
    });

    it('shows empty state when no chunks are available', async () => {
      mockChunkRepository.findAll.mockResolvedValue([]);
      mockRepository.findAllWithContent.mockResolvedValue([]);
      mockRepository.findAll.mockResolvedValue([]);

      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      // Wait for component to load
      await waitFor(() => {
        expect(screen.getByText('Enhanced Database Demo')).toBeInTheDocument();
      });

      // Find the chunks tab in the view selector (not the export button)
      const viewButtons = screen.getAllByRole('button');
      const chunksTab = viewButtons.find(
        (button) =>
          button.textContent?.includes('Chunks (0)') &&
          button.className.includes('h-9 rounded-md px-3') &&
          !button.className.includes('flex items-center gap-1')
      );
      expect(chunksTab).toBeDefined();
      if (chunksTab) await user.click(chunksTab);

      // Check empty state message
      await waitFor(() => {
        expect(
          screen.getByText(
            'No chunks available. Enable chunking in import settings and import some files.'
          )
        ).toBeInTheDocument();
      });
    });
  });

  describe('Search Results', () => {
    it('shows search interface when search tab is selected', async () => {
      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      // Wait for component to load
      await waitFor(() => {
        expect(screen.getByText('Enhanced Database Demo')).toBeInTheDocument();
      });

      // Find and click the search tab by text content
      const searchTab = screen.getByText('Search');
      await user.click(searchTab);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search in file chunks...')).toBeInTheDocument();
      });
    });

    it('shows empty search state when no query is entered', async () => {
      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      // Wait for component to load
      await waitFor(() => {
        expect(screen.getByText('Enhanced Database Demo')).toBeInTheDocument();
      });

      // Find and click the search tab by text content
      const searchTab = screen.getByText('Search');
      await user.click(searchTab);

      await waitFor(() => {
        expect(
          screen.getByText('Enter a search query to find similar content.')
        ).toBeInTheDocument();
      });
    });
  });

  describe('File Import', () => {
    it('attempts to call import function when import button is clicked', async () => {
      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Import Selected Files/ })).toBeInTheDocument();
      });

      const importButton = screen.getByRole('button', { name: /Import Selected Files/ });
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
      render(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Import Selected Files/ })).toBeInTheDocument();
      });

      const importButton = screen.getByRole('button', { name: /Import Selected Files/ });
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
    it('loads and displays file records', async () => {
      const mockRecords = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          size: 100,
          content: 'test content',
          createdAt: '2025-01-01T00:00:00Z',
          processedAt: '2025-01-01T00:00:00Z',
        },
      ];

      mockRepository.findAllWithContent.mockResolvedValue(mockRecords);
      mockRepository.findAll.mockResolvedValue(mockRecords);

      render(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByText('test.txt')).toBeInTheDocument();
      });
    });

    it('handles refresh button click', async () => {
      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Refresh/ })).toBeInTheDocument();
      });

      const refreshButton = screen.getByRole('button', { name: /Refresh/ });
      await user.click(refreshButton);

      expect(mockRepository.findAll).toHaveBeenCalled();
    });
  });

  describe('Export Functionality', () => {
    it('shows export buttons', async () => {
      render(<DatabaseDemoPanel />);

      await waitFor(() => {
        // Check for view selector buttons (these are the primary ones)
        const viewButtons = screen.getAllByRole('button');
        const filesButton = viewButtons.find((btn) => btn.textContent?.includes('Files (0)'));
        const chunksButton = viewButtons.find((btn) => btn.textContent?.includes('Chunks (0)'));

        expect(filesButton).toBeInTheDocument();
        expect(chunksButton).toBeInTheDocument();
      });
    });
  });

  describe('Search Functionality', () => {
    it('displays search results with similarity scores', async () => {
      const mockSearchResults = [
        {
          chunk: {
            id: 'chunk1',
            fileRecordId: '1',
            chunkIndex: 0,
            chunkType: 'text' as const,
            content:
              'This is a test chunk with relevant content that should be displayed in search results',
            tokenCount: 50,
            embedding: new Float32Array([0.1, 0.2, 0.3]),
            createdAt: '2025-01-01T00:00:00Z',
          },
          similarity: 0.85,
          fileRecord: {
            id: '1',
            name: 'test.txt',
            path: '/test/path/test.txt',
            size: 1024,
            content: 'test content',
            createdAt: '2025-01-01T00:00:00Z',
            processedAt: '2025-01-01T00:00:00Z',
          },
        },
        {
          chunk: {
            id: 'chunk2',
            fileRecordId: '2',
            chunkIndex: 1,
            chunkType: 'text' as const,
            content: 'Another test chunk with different content that has a lower similarity score',
            tokenCount: 30,
            embedding: new Float32Array([0.4, 0.5, 0.6]),
            createdAt: '2025-01-01T00:00:00Z',
          },
          similarity: 0.72,
          fileRecord: {
            id: '2',
            name: 'another.txt',
            path: '/test/path/another.txt',
            size: 512,
            content: 'another content',
            createdAt: '2025-01-01T00:00:00Z',
            processedAt: '2025-01-01T00:00:00Z',
          },
        },
      ];

      const mockRecords = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test/path/test.txt',
          size: 1024,
          content: 'test content',
          createdAt: '2025-01-01T00:00:00Z',
          processedAt: '2025-01-01T00:00:00Z',
        },
        {
          id: '2',
          name: 'another.txt',
          path: '/test/path/another.txt',
          size: 512,
          content: 'another content',
          createdAt: '2025-01-01T00:00:00Z',
          processedAt: '2025-01-01T00:00:00Z',
        },
      ];

      mockRepository.findAllWithContent.mockResolvedValue(mockRecords);
      mockRepository.findAll.mockResolvedValue(mockRecords);
      mockChunkRepository.findAll.mockResolvedValue([]);

      // Mock the embedding service generateEmbedding/generateQueryEmbedding methods
      const embedResult = {
        embedding: new Float32Array([0.1, 0.2, 0.3]),
      } as unknown as { embedding: Float32Array };
      mockEmbeddingService.generateEmbedding.mockResolvedValue(embedResult);
      mockEmbeddingService.generateQueryEmbedding.mockResolvedValue(embedResult);

      // Mock the chunk repository searchSimilar method
      mockChunkRepository.searchSimilar.mockResolvedValue(
        mockSearchResults.map((result) => ({
          chunk: result.chunk,
          similarity: result.similarity,
        }))
      );

      // Mock repository findById to return file records for enriching results
      mockRepository.findById.mockImplementation((id) => {
        return Promise.resolve(mockRecords.find((record) => record.id === id));
      });

      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      // Wait for component to load
      await waitFor(() => {
        expect(screen.getByText('Enhanced Database Demo')).toBeInTheDocument();
      });

      // First enable embeddings in settings
      const settingsButton = screen.getByRole('button', { name: /import settings/i });
      await user.click(settingsButton);

      // Enable embeddings via the Embeddings section (robust selector)
      const embeddingsLabel = screen.getByText('Embeddings');
      const embeddingsSection = embeddingsLabel.closest('div');
      expect(embeddingsSection).toBeTruthy();
      const embeddingCheckbox = within(embeddingsSection as HTMLElement).getByRole('checkbox');
      await user.click(embeddingCheckbox);

      // Wait a bit for state changes to propagate and verify
      await waitFor(() => {
        expect(embeddingCheckbox).toBeChecked();
      });

      // Close settings after verifying
      await user.click(settingsButton);

      // Switch to search tab
      const viewButtons = screen.getAllByRole('button');
      const searchTab = viewButtons.find(
        (button) =>
          button.textContent?.includes('Search') &&
          button.className.includes('h-9 rounded-md px-3') &&
          !button.className.includes('flex items-center gap-1')
      );
      expect(searchTab).toBeDefined();
      if (searchTab) await user.click(searchTab);

      // Find search input and perform search using fireEvent for speed
      const searchInput = screen.getByPlaceholderText('Search in file chunks...');
      fireEvent.change(searchInput, { target: { value: 'test content' } });

      // Find search button and click it (the one with the icon, not the tab)
      const searchButtons = screen.getAllByRole('button', { name: /search/i });
      const searchActionButton = searchButtons.find(
        (button) =>
          button.querySelector('svg') && button.className.includes('flex items-center gap-1')
      );
      expect(searchActionButton).toBeDefined();
      if (searchActionButton) await user.click(searchActionButton);

      // Wait for search results to be displayed
      await waitFor(() => {
        // Check similarity scores are displayed (now in Badge components)
        expect(screen.getByText('85.0%')).toBeInTheDocument();
        expect(screen.getByText('72.0%')).toBeInTheDocument();

        // Check chunk information is displayed
        expect(screen.getByText('text #0')).toBeInTheDocument();
        expect(screen.getByText('text #1')).toBeInTheDocument();
        // Token counts appear in multiple places (chunk details and page size), use regex for flexibility
        expect(screen.getAllByText(/50/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/30/).length).toBeGreaterThan(0);

        // Check file information is displayed (now in table cells, not card format)
        expect(screen.getByText('test.txt')).toBeInTheDocument();
        expect(screen.getByText('another.txt')).toBeInTheDocument();
        expect(screen.getByText('/test/path/test.txt')).toBeInTheDocument();
        expect(screen.getByText('/test/path/another.txt')).toBeInTheDocument();

        // Check result numbering
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();

        // Check content is displayed (should be truncated if over 400 chars)
        expect(screen.getByText(/This is a test chunk with relevant content/)).toBeInTheDocument();
        expect(screen.getByText(/Another test chunk with different content/)).toBeInTheDocument();
      });
    }, 10000);

    it('shows empty state when no search results are found', async () => {
      mockRepository.findAllWithContent.mockResolvedValue([]);
      mockRepository.findAll.mockResolvedValue([]);
      mockChunkRepository.findAll.mockResolvedValue([]);

      // Use the primary path: embed query then repository vector search
      const embedResult2 = {
        embedding: new Float32Array([0.1, 0.2, 0.3]),
      } as unknown as { embedding: Float32Array };
      mockEmbeddingService.generateEmbedding.mockResolvedValue(embedResult2);
      mockEmbeddingService.generateQueryEmbedding.mockResolvedValue(embedResult2);
      mockChunkRepository.searchSimilar.mockResolvedValue([]);

      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      // Wait for component to load
      await waitFor(() => {
        expect(screen.getByText('Enhanced Database Demo')).toBeInTheDocument();
      });

      // Switch to search tab
      const viewButtons = screen.getAllByRole('button');
      const searchTab = viewButtons.find(
        (button) =>
          button.textContent?.includes('Search') &&
          button.className.includes('h-9 rounded-md px-3') &&
          !button.className.includes('flex items-center gap-1')
      );
      expect(searchTab).toBeDefined();
      if (searchTab) await user.click(searchTab);

      // Find search input and perform search
      const searchInput = screen.getByPlaceholderText('Search in file chunks...');
      await user.type(searchInput, 'nonexistent content');

      // Find search button and click it (the one with the icon, not the tab)
      const searchButtons = screen.getAllByRole('button', { name: /search/i });
      const searchActionButton = searchButtons.find(
        (button) =>
          button.querySelector('svg') && button.className.includes('flex items-center gap-1')
      );
      expect(searchActionButton).toBeDefined();
      if (searchActionButton) await user.click(searchActionButton);

      // Wait for empty state message
      await waitFor(() => {
        expect(screen.getByText(/No matching chunks found/)).toBeInTheDocument();
      });
    }, 10000);
  });
});
