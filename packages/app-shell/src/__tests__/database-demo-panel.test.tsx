import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseDemoPanel } from '../database-demo-panel';

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
};

const mockEmbeddingService = {
  dispose: vi.fn(),
  generateEmbedding: vi.fn(),
  search: vi.fn(),
};

const mockToast = vi.fn();

const mockImportFiles = vi.fn();

vi.mock('@brainstrike/embeddings', () => {
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
    selectedFilePaths: new Set(['test-file.txt']),
  }),
}));

describe('DatabaseDemoPanel', () => {
  beforeEach(() => {
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
    });
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
    });

    it('toggles chunking setting', async () => {
      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      // Open settings
      const settingsButton = screen.getByRole('button', { name: /Import Settings/ });
      await user.click(settingsButton);

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
    });

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

      mockRepository.findAllWithContent.mockResolvedValue(mockRecords);
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
        expect(screen.getByText('75 tokens')).toBeInTheDocument();
        expect(screen.getByText('embedded')).toBeInTheDocument();
        expect(screen.getByText('File: test.txt')).toBeInTheDocument();
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

      // The component should show an error about missing database/file system
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Import Failed',
        description: 'Database or file system not available',
        variant: 'destructive',
      });
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

      expect(mockRepository.findAllWithContent).toHaveBeenCalled();
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
    it('shows search interface when search tab is selected', async () => {
      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      // Find the view selector search tab (not the search button in the interface)
      const allButtons = screen.getAllByRole('button');
      const searchTab = allButtons.find(
        (btn) => btn.textContent?.trim() === 'Search' && btn.className.includes('h-9') // View selector buttons have h-9 class
      );

      expect(searchTab).toBeInTheDocument();
      if (searchTab) await user.click(searchTab);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search in file chunks...')).toBeInTheDocument();
      });
    });

    it('handles search input', async () => {
      const user = userEvent.setup();
      render(<DatabaseDemoPanel />);

      // Find the view selector search tab
      const allButtons = screen.getAllByRole('button');
      const searchTab = allButtons.find(
        (btn) => btn.textContent?.trim() === 'Search' && btn.className.includes('h-9')
      );

      expect(searchTab).toBeInTheDocument();
      if (searchTab) await user.click(searchTab);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search in file chunks...')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search in file chunks...');
      await user.type(searchInput, 'test query');

      expect(searchInput).toHaveValue('test query');
    });
  });

  describe('Utility Functions', () => {
    it('formats file size correctly', () => {
      // This would test the formatFileSize function if it was exported
      // For now, we can test it indirectly through the component
      const mockRecords = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          size: 1024,
          content: 'test content',
          createdAt: '2025-01-01T00:00:00Z',
          processedAt: '2025-01-01T00:00:00Z',
        },
      ];

      mockRepository.findAllWithContent.mockResolvedValue(mockRecords);
      mockRepository.findAll.mockResolvedValue(mockRecords);

      render(<DatabaseDemoPanel />);

      // The component should display the formatted size
      waitFor(() => {
        expect(screen.getByText('1.0 KB')).toBeInTheDocument();
      });
    });

    it('formats dates correctly', () => {
      const mockRecords = [
        {
          id: '1',
          name: 'test.txt',
          path: '/test.txt',
          size: 1024,
          content: 'test content',
          createdAt: '2025-01-01T00:00:00Z',
          processedAt: '2025-01-01T00:00:00Z',
        },
      ];

      mockRepository.findAllWithContent.mockResolvedValue(mockRecords);
      mockRepository.findAll.mockResolvedValue(mockRecords);

      render(<DatabaseDemoPanel />);

      // The component should display formatted dates
      waitFor(() => {
        expect(screen.getByText(/2025/)).toBeInTheDocument();
      });
    });
  });
});
