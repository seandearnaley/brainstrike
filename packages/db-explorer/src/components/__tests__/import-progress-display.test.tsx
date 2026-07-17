import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportProgressDisplay } from '../import-progress-display';

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    Progress: ({
      value,
      className,
      ...rest
    }: { value?: number; className?: string } & Record<string, unknown>) => (
      <div className={className} data-testid="progress-bar" {...rest}>
        {Math.round(value ?? 0)}%
      </div>
    ),
  };
});

describe('ImportProgressDisplay', () => {
  it('renders basic import progress', () => {
    const mockProgress = {
      completed: 1,
      errors: [],
      phase: 'importing' as const,
      total: 10,
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    expect(screen.getByText('Import Progress')).toBeInTheDocument();
    expect(screen.getByText('1 of 10 files')).toBeInTheDocument();
  });

  it('renders chunking progress details', () => {
    const mockProgress = {
      chunkingProgress: {
        chunksCreated: 42,
        currentFile: 'test-file.txt',
        filesProcessed: 2,
        totalFiles: 5,
      },
      completed: 2,
      errors: [],
      phase: 'chunking' as const,
      total: 5,
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
      completed: 10,
      embeddingProgress: {
        chunksProcessed: 10,
        currentChunk: 'chunk-123',
        modelName: 'text-embedding-3-small',
        totalChunks: 20,
      },
      errors: [],
      phase: 'embedding' as const,
      total: 20,
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
      completed: 1,
      errors: [],
      phase: 'importing' as const,
      total: 10,
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    expect(screen.queryByText('Chunking')).not.toBeInTheDocument();
  });

  it('does not render embedding details when not in embedding phase', () => {
    const mockProgress = {
      chunkingProgress: {
        chunksCreated: 5,
        currentFile: 'test.txt',
        filesProcessed: 1,
        totalFiles: 10,
      },
      completed: 1,
      errors: [],
      phase: 'chunking' as const,
      total: 10,
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    expect(screen.queryByText('Embedding')).not.toBeInTheDocument();
    expect(screen.queryByText(/Model:/i)).not.toBeInTheDocument();
  });

  it('calls onClose when provided', () => {
    const mockOnClose = vi.fn();
    const mockProgress = {
      completed: 1,
      errors: [],
      phase: 'importing' as const,
      total: 10,
    };

    render(<ImportProgressDisplay onClose={mockOnClose} progress={mockProgress} />);

    const closeButton = screen.getByRole('button', { name: /close import progress/i });
    closeButton.click();

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('handles complete progress correctly', () => {
    const mockProgress = {
      chunkingProgress: {
        chunksCreated: 100,
        currentFile: 'last-file.txt',
        filesProcessed: 5,
        totalFiles: 5,
      },
      completed: 5,
      errors: [],
      phase: 'chunking' as const,
      total: 5,
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    // Check progress bar shows 100%
    const progressBars = screen.getAllByTestId('progress-bar');
    expect(progressBars.some((bar) => bar.textContent === '100%')).toBe(true);
    expect(screen.getByText('5/5')).toBeInTheDocument();
  });

  it('renders strategy when provided', () => {
    const mockProgress = {
      chunkingProgress: {
        chunksCreated: 12,
        currentFile: 'code.ts',
        filesProcessed: 1,
        strategyUsed: 'recursive' as const,
        totalFiles: 3,
      },
      completed: 1,
      errors: [],
      phase: 'chunking' as const,
      total: 3,
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    expect(screen.getByText('Strategy: recursive')).toBeInTheDocument();
  });

  it('renders queue progress details when provided', () => {
    const mockProgress = {
      completed: 3,
      errors: [],
      phase: 'embedding' as const,
      queueProgress: {
        failed: 1,
        lastError: null,
        lastEvent: {
          chunkId: 'chunk-42',
          elapsedMs: 128,
          model: 'text-embedding-3-small',
          status: 'completed' as const,
        },
        pending: 2,
        processed: 5,
        totalQueued: 8,
      },
      total: 10,
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    expect(screen.getByText('Queue')).toBeInTheDocument();
    expect(screen.getByText('6/8')).toBeInTheDocument();
    expect(screen.getByText(/Pending: 2 · Failed: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Last: completed · text-embedding-3-small/)).toBeInTheDocument();
    expect(screen.getByText(/\(128ms\)/)).toBeInTheDocument();
  });

  it('exposes the error disclosure with aria-expanded + aria-controls', () => {
    const mockProgress = {
      completed: 5,
      errors: [
        { error: 'boom', file: 'a.txt' },
        { error: 'kaboom', file: 'b.txt' },
      ],
      phase: 'importing' as const,
      total: 5,
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
      chunkingProgress: {
        chunksCreated: 8,
        currentFile: 'x.ts',
        filesProcessed: 2,
        totalFiles: 5,
      },
      completed: 4,
      embeddingProgress: {
        chunksProcessed: 3,
        currentChunk: 'c-1',
        modelName: 'gemma',
        totalChunks: 6,
      },
      errors: [],
      phase: 'embedding' as const,
      total: 10,
    };

    render(<ImportProgressDisplay onClose={vi.fn()} progress={mockProgress} />);

    expect(screen.getByText('Chunking')).toBeInTheDocument();
    expect(screen.getByText('Embedding')).toBeInTheDocument();
    expect(screen.getByText('4 of 10 files')).toBeInTheDocument();
    // Each Progress in this rendering should carry its own aria-label so screen
    // readers can distinguish the three stages.
    const labels = screen
      .getAllByTestId('progress-bar')
      .map((bar) => bar.getAttribute('aria-label'));
    expect(labels).toEqual(
      expect.arrayContaining(['Chunking progress', 'Embedding progress', 'Import progress'])
    );
  });

  it('renders the spinner stage with aria-hidden when not complete', () => {
    const mockProgress = {
      completed: 1,
      errors: [],
      phase: 'importing' as const,
      total: 10,
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
