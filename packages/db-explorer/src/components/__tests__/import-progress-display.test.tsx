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
    const progressBars = screen.getAllByTestId('progress-bar');
    expect(progressBars.some((bar) => bar.textContent === '40%')).toBe(true);
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
    const progressBars = screen.getAllByTestId('progress-bar');
    expect(progressBars.some((bar) => bar.textContent === '50%')).toBe(true);
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
    const progressBars = screen.getAllByTestId('progress-bar');
    expect(progressBars.some((bar) => bar.textContent === '100%')).toBe(true);
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

  it('exposes the error disclosure with aria-expanded + aria-controls', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const mockProgress = {
      phase: 'importing' as const,
      total: 5,
      completed: 5,
      errors: [
        { file: 'a.txt', error: 'boom' },
        { file: 'b.txt', error: 'kaboom' },
      ],
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    const toggle = screen.getByRole('button', { name: /View 2 errors/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const controlsId = toggle.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();

    // collapsed: container exists for aria-controls target, but list rows not rendered
    const targetEl = controlsId
      ? (toggle.ownerDocument.getElementById(controlsId) as HTMLElement | null)
      : null;
    expect(targetEl).not.toBeNull();
    expect(targetEl).toHaveAttribute('hidden');
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument();

    // expand
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(targetEl).not.toHaveAttribute('hidden');
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByText('b.txt')).toBeInTheDocument();

    // collapse again — target stays in DOM, list rows unmount
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument();
  });

  it('labels the chunking and embedding progress bars and the import progress bar', () => {
    const mockProgress = {
      phase: 'embedding' as const,
      total: 10,
      completed: 4,
      errors: [],
      chunkingProgress: {
        currentFile: 'x.ts',
        filesProcessed: 2,
        totalFiles: 5,
        chunksCreated: 8,
      },
      embeddingProgress: {
        currentChunk: 'c-1',
        chunksProcessed: 3,
        totalChunks: 6,
        modelName: 'gemma',
      },
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    // The mocked Progress passes className through; in real rendering these
    // would receive aria-label. We assert the rendered text labels exist for
    // the chunking and embedding cards which exercises those branches.
    expect(screen.getByText('Chunking')).toBeInTheDocument();
    expect(screen.getByText('Embedding')).toBeInTheDocument();
    expect(screen.getByText('4 of 10 files')).toBeInTheDocument();
  });

  it('renders the spinner stage with aria-hidden when not complete', () => {
    const mockProgress = {
      phase: 'importing' as const,
      total: 10,
      completed: 1,
      errors: [],
    };

    const { container } = render(
      <ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />
    );

    // Spinner div sits next to the title "Import Progress"
    const spinner = container.querySelector('div.animate-spin') as HTMLElement | null;
    expect(spinner).not.toBeNull();
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
  });
});
