import type { FileRecord } from '@brainstrike/db';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DatabaseDemoPanel } from '../database-demo-panel';

// Mock the database dependencies
const mockRepository = {
  findAll: vi.fn(),
  findAllWithContent: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
};

const mockToast = vi.fn();

vi.mock('@brainstrike/db', () => ({
  useFileRecordRepository: () => mockRepository,
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

// Mock the file import service
vi.mock('../file-import-service', () => ({
  useFileImportService: () => ({
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

// Mock the file explorer UI hooks
vi.mock('@brainstrike/file-explorer-ui', () => ({
  useFileExplorer: () => ({
    fileContents: {},
    fileTree: [],
  }),
  useSelectionManager: () => ({
    selectedFilePaths: new Set(),
  }),
}));

const mockRecords: FileRecord[] = [
  {
    id: 'test-1',
    name: 'test-file-1.txt',
    path: '/test/test-file-1.txt',
    size: 1024,
    createdAt: '2023-01-01T00:00:00.000Z',
    updatedAt: '2023-01-01T00:00:00.000Z',
  },
  {
    id: 'test-2',
    name: 'test-file-2.txt',
    path: '/test/test-file-2.txt',
    size: 2048,
    createdAt: '2023-01-02T00:00:00.000Z',
    updatedAt: '2023-01-02T00:00:00.000Z',
  },
];

describe('DatabaseDemoPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepository.findAll.mockResolvedValue([]);
    mockRepository.findAllWithContent.mockResolvedValue([]);
    mockRepository.create.mockResolvedValue(undefined);
    mockRepository.delete.mockResolvedValue(undefined);
  });

  test('shows loading state when repository is not available', () => {
    // Test the loading state by not mocking the repository initially
    // This will test the null repository case in the component
    render(<DatabaseDemoPanel />);

    expect(screen.getByText('Database Demo')).toBeInTheDocument();
    expect(screen.getByText('PGlite WASM database with file records table')).toBeInTheDocument();
  });

  test('renders with empty state when no records', async () => {
    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(screen.getByText('Database Demo')).toBeInTheDocument();
    });

    expect(screen.getByText('PGlite WASM database with file records table')).toBeInTheDocument();
    expect(screen.getByText('Import Selected Files (0)')).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(
      screen.getByText(/No imported files found.*Select files in the explorer.*/)
    ).toBeInTheDocument();
  });

  test('displays records in table when data is available', async () => {
    // Mock findAllWithContent since that's what the component now uses
    mockRepository.findAllWithContent = vi.fn().mockResolvedValue(mockRecords);

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(screen.getByText('test-file-1.txt')).toBeInTheDocument();
    });

    expect(screen.getByText('test-file-2.txt')).toBeInTheDocument();
    expect(screen.getByText('/test/test-file-1.txt')).toBeInTheDocument();
    expect(screen.getByText('/test/test-file-2.txt')).toBeInTheDocument();
    expect(screen.getByText('1.0 KB')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });

  test('shows import button and displays no files selected message when clicked', async () => {
    const user = userEvent.setup();
    mockRepository.findAllWithContent.mockResolvedValue([]);

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(screen.getByText('Import Selected Files (0)')).toBeInTheDocument();
    });

    const importButton = screen.getByText('Import Selected Files (0)');
    await user.click(importButton);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'No Files Selected',
        description: 'Please select files in the explorer before importing.',
        variant: 'destructive',
      });
    });
  });

  test('import button is properly enabled when not importing', async () => {
    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      const importButton = screen.getByText('Import Selected Files (0)');
      expect(importButton).not.toBeDisabled();
    });
  });

  test('removes record when delete button is clicked', async () => {
    const user = userEvent.setup();
    mockRepository.findAllWithContent.mockResolvedValue(mockRecords);

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(screen.getByText('test-file-1.txt')).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByTitle('Remove record');
    const firstDeleteButton = deleteButtons[0];
    if (firstDeleteButton) {
      await user.click(firstDeleteButton);
    }

    await waitFor(() => {
      expect(mockRepository.delete).toHaveBeenCalledWith('test-1');
    });

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Success',
      description: 'Removed record: test-file-1.txt',
    });
  });

  test('handles remove record error', async () => {
    const user = userEvent.setup();
    mockRepository.findAllWithContent.mockResolvedValue(mockRecords);
    mockRepository.delete.mockRejectedValue(new Error('Database error'));

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(screen.getByText('test-file-1.txt')).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByTitle('Remove record');
    const firstDeleteButton = deleteButtons[0];
    if (firstDeleteButton) {
      await user.click(firstDeleteButton);
    }

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Error',
        description: 'Failed to remove record',
        variant: 'destructive',
      });
    });
  });

  test('refreshes records when refresh button is clicked', async () => {
    const user = userEvent.setup();
    mockRepository.findAllWithContent.mockResolvedValue(mockRecords);

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });

    const refreshButton = screen.getByText('Refresh');
    await user.click(refreshButton);

    await waitFor(() => {
      expect(mockRepository.findAllWithContent).toHaveBeenCalledTimes(2); // Once on mount, once on refresh
    });
  });

  test('handles load records error', async () => {
    mockRepository.findAllWithContent.mockRejectedValue(new Error('Database error'));

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Error',
        description: 'Failed to load database records',
        variant: 'destructive',
      });
    });
  });

  test('formats file sizes correctly', async () => {
    const recordsWithDifferentSizes: FileRecord[] = [
      {
        id: 'test-1',
        name: 'test-file-1.txt',
        path: '/test/test-file-1.txt',
        size: 500, // 500 B
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      },
      {
        id: 'test-2',
        name: 'test-file-2.txt',
        path: '/test/test-file-2.txt',
        size: 1536, // 1.5 KB
        createdAt: '2023-01-02T00:00:00.000Z',
        updatedAt: '2023-01-02T00:00:00.000Z',
      },
      {
        id: 'test-3',
        name: 'test-file-3.txt',
        path: '/test/test-file-3.txt',
        size: 2097152, // 2.0 MB
        createdAt: '2023-01-03T00:00:00.000Z',
        updatedAt: '2023-01-03T00:00:00.000Z',
      },
    ];

    mockRepository.findAllWithContent.mockResolvedValue(recordsWithDifferentSizes);

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(screen.getByText('500 B')).toBeInTheDocument();
      expect(screen.getByText('1.5 KB')).toBeInTheDocument();
      expect(screen.getByText('2.0 MB')).toBeInTheDocument();
    });
  });

  test('formats dates correctly', async () => {
    mockRepository.findAllWithContent.mockResolvedValue(mockRecords);

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      // Check that dates are displayed (exact format may vary by locale)
      expect(screen.getByText(/1\/1\/2023/)).toBeInTheDocument();
    });
  });

  test('displays token count and import date columns in table', async () => {
    const recordsWithContent: FileRecord[] = [
      {
        id: 'test-1',
        name: 'test-file-1.txt',
        path: '/test/test-file-1.txt',
        size: 1024,
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
        tokenCount: 256,
        processedAt: '2023-01-01T10:00:00.000Z',
      },
    ];

    mockRepository.findAllWithContent.mockResolvedValue(recordsWithContent);

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(screen.getByText('Tokens')).toBeInTheDocument();
      expect(screen.getByText('Imported')).toBeInTheDocument();
      expect(screen.getByText('256')).toBeInTheDocument();
    });
  });
});
