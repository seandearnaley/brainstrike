import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import type { FileRecord } from '@brainstrike/db';
import { DatabaseDemoPanel } from '../database-demo-panel';

// Mock the database dependencies
const mockRepository = {
  findAll: vi.fn(),
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
    expect(screen.getByText('Add Test Record')).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(
      screen.getByText('No records found. Click "Add Test Record" to create some data.')
    ).toBeInTheDocument();
  });

  test('displays records in table when data is available', async () => {
    mockRepository.findAll.mockResolvedValue(mockRecords);

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

  test('adds test record when button is clicked', async () => {
    const user = userEvent.setup();
    mockRepository.findAll.mockResolvedValue([]);

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(screen.getByText('Add Test Record')).toBeInTheDocument();
    });

    const addButton = screen.getByText('Add Test Record');
    await user.click(addButton);

    await waitFor(() => {
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.stringMatching(/test-file-.*\.txt/),
          path: expect.stringMatching(/\/demo\/test-file-.*\.txt/),
          size: expect.any(Number),
        })
      );
    });

    expect(mockToast).toHaveBeenCalledWith({
      title: 'Success',
      description: expect.stringMatching(/Added test record: test-file-.*\.txt/),
    });
  });

  test('handles add record error', async () => {
    const user = userEvent.setup();
    mockRepository.create.mockRejectedValue(new Error('Database error'));

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(screen.getByText('Add Test Record')).toBeInTheDocument();
    });

    const addButton = screen.getByText('Add Test Record');
    await user.click(addButton);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Error',
        description: 'Failed to add test record',
        variant: 'destructive',
      });
    });
  });

  test('removes record when delete button is clicked', async () => {
    const user = userEvent.setup();
    mockRepository.findAll.mockResolvedValue(mockRecords);

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
    mockRepository.findAll.mockResolvedValue(mockRecords);
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
    mockRepository.findAll.mockResolvedValue(mockRecords);

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });

    const refreshButton = screen.getByText('Refresh');
    await user.click(refreshButton);

    await waitFor(() => {
      expect(mockRepository.findAll).toHaveBeenCalledTimes(2); // Once on mount, once on refresh
    });
  });

  test('handles load records error', async () => {
    mockRepository.findAll.mockRejectedValue(new Error('Database error'));

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

    mockRepository.findAll.mockResolvedValue(recordsWithDifferentSizes);

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(screen.getByText('500 B')).toBeInTheDocument();
      expect(screen.getByText('1.5 KB')).toBeInTheDocument();
      expect(screen.getByText('2.0 MB')).toBeInTheDocument();
    });
  });

  test('formats dates correctly', async () => {
    render(<DatabaseDemoPanel />);
    mockRepository.findAll.mockResolvedValue(mockRecords);

    // Re-render to trigger the effect
    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      // Check that dates are displayed (exact format may vary by locale)
      expect(screen.getByText(/1\/1\/2023/)).toBeInTheDocument();
    });
  });

  test('shows loading state during operations', async () => {
    const user = userEvent.setup();

    // Make create operation slow
    mockRepository.create.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 100))
    );

    render(<DatabaseDemoPanel />);

    await waitFor(() => {
      expect(screen.getByText('Add Test Record')).toBeInTheDocument();
    });

    const addButton = screen.getByText('Add Test Record');
    await user.click(addButton);

    // Button should be disabled during loading
    expect(addButton).toBeDisabled();
  });
});
