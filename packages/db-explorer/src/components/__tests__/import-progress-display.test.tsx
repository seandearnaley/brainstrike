import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportProgressDisplay } from '../import-progress-display';

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    Progress: ({ value, className }: { value?: number; className?: string }) => (
      <div className={className} data-testid="progress-bar">
        {Math.round(value ?? 0)}%
      </div>
    ),
  };
});

describe('ImportProgressDisplay', () => {
  it('renders basic import progress', () => {
    const mockProgress = {
      phase: 'importing' as const,
      total: 10,
      completed: 1,
      errors: [],
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    expect(screen.getByText('Import Progress')).toBeInTheDocument();
    expect(screen.getByText('1 of 10 files')).toBeInTheDocument();
  });

  it('renders chunking progress details', () => {
    const mockProgress = {
      phase: 'chunking' as const,
      total: 5,
      completed: 2,
      errors: [],
      chunkingProgress: {
        currentFile: 'test-file.txt',
        filesProcessed: 2,
        totalFiles: 5,
        chunksCreated: 42,
      },
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    expect(screen.getByText('Chunking')).toBeInTheDocument();
    expect(screen.getByText('test-file.txt')).toBeInTheDocument();
    expect(screen.getByText('2/5')).toBeInTheDocument();
    expect(screen.getByText('42 chunks created')).toBeInTheDocument();

    // Check progress bar value: (2/5) * 100 = 40%
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('renders embedding progress details', () => {
    const mockProgress = {
      phase: 'embedding' as const,
      total: 20,
      completed: 10,
      errors: [],
      embeddingProgress: {
        currentChunk: 'chunk-123',
        chunksProcessed: 10,
        totalChunks: 20,
        modelName: 'text-embedding-3-small',
      },
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    expect(screen.getByText('Embedding')).toBeInTheDocument();
    expect(screen.getByText('chunk-123')).toBeInTheDocument();
    expect(screen.getByText('10/20')).toBeInTheDocument();
    expect(screen.getByText('Model: text-embedding-3-small')).toBeInTheDocument();

    // Check progress bar value: (10/20) * 100 = 50%
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('does not render chunking details when not in chunking phase', () => {
    const mockProgress = {
      phase: 'importing' as const,
      total: 10,
      completed: 1,
      errors: [],
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    expect(screen.queryByText('Chunking')).not.toBeInTheDocument();
  });

  it('does not render embedding details when not in embedding phase', () => {
    const mockProgress = {
      phase: 'chunking' as const,
      total: 10,
      completed: 1,
      errors: [],
      chunkingProgress: {
        currentFile: 'test.txt',
        filesProcessed: 1,
        totalFiles: 10,
        chunksCreated: 5,
      },
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    expect(screen.queryByText('Embedding')).not.toBeInTheDocument();
    expect(screen.queryByText(/Model:/i)).not.toBeInTheDocument();
  });

  it('calls onClose when provided', () => {
    const mockOnClose = vi.fn();
    const mockProgress = {
      phase: 'importing' as const,
      total: 10,
      completed: 1,
      errors: [],
    };

    render(<ImportProgressDisplay onClose={mockOnClose} progress={mockProgress} />);

    const closeButton = screen.getByRole('button', { name: /close import progress/i });
    closeButton.click();

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('handles complete progress correctly', () => {
    const mockProgress = {
      phase: 'chunking' as const,
      total: 5,
      completed: 5,
      errors: [],
      chunkingProgress: {
        currentFile: 'last-file.txt',
        filesProcessed: 5,
        totalFiles: 5,
        chunksCreated: 100,
      },
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    // Check progress bar shows 100%
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText('5/5')).toBeInTheDocument();
  });

  it('renders strategy when provided', () => {
    const mockProgress = {
      phase: 'chunking' as const,
      total: 3,
      completed: 1,
      errors: [],
      chunkingProgress: {
        currentFile: 'code.ts',
        filesProcessed: 1,
        totalFiles: 3,
        chunksCreated: 12,
        strategyUsed: 'recursive' as const,
      },
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    expect(screen.getByText('Strategy: recursive')).toBeInTheDocument();
  });

  it('renders queue progress details when provided', () => {
    const mockProgress = {
      phase: 'embedding' as const,
      total: 10,
      completed: 3,
      errors: [],
      queueProgress: {
        pending: 2,
        processed: 5,
        failed: 1,
        totalQueued: 8,
        lastError: null,
        lastEvent: {
          chunkId: 'chunk-42',
          status: 'completed' as const,
          model: 'text-embedding-3-small',
          elapsedMs: 128,
        },
      },
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    expect(screen.getByText('Queue')).toBeInTheDocument();
    expect(screen.getByText('6/8')).toBeInTheDocument();
    expect(screen.getByText(/Pending: 2 · Failed: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Last: completed · text-embedding-3-small/)).toBeInTheDocument();
    expect(screen.getByText(/\(128ms\)/)).toBeInTheDocument();
  });
});
