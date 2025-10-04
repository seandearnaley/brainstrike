import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ImportProgressDisplayProps } from '../../types';
import { ImportProgressDisplay } from '../import-progress-display';

vi.mock('@brainstrike/ui', () => ({
  ImportProgress: ({
    progress,
    onClose,
  }: {
    progress: ImportProgressDisplayProps['progress'];
    onClose?: () => void;
  }) => (
    <div data-testid="import-progress">
      <div>{progress.phase}</div>
      {onClose && (
        <button type="button" onClick={onClose}>
          Close
        </button>
      )}
    </div>
  ),
  Progress: ({ value, className }: { value: number; className?: string }) => (
    <div data-testid="progress-bar" className={className}>
      {value}%
    </div>
  ),
}));

describe('ImportProgressDisplay', () => {
  it('renders basic import progress', () => {
    const mockProgress = {
      phase: 'importing' as const,
      current: 1,
      total: 10,
    };

    render(<ImportProgressDisplay progress={mockProgress} />);

    expect(screen.getByTestId('import-progress')).toBeInTheDocument();
    expect(screen.getByText('importing')).toBeInTheDocument();
  });

  it('renders chunking progress details', () => {
    const mockProgress = {
      phase: 'chunking' as const,
      current: 2,
      total: 5,
      chunkingProgress: {
        currentFile: 'test-file.txt',
        filesProcessed: 2,
        totalFiles: 5,
        chunksCreated: 42,
      },
    };

    render(<ImportProgressDisplay progress={mockProgress} />);

    expect(screen.getByText('chunking')).toBeInTheDocument();
    expect(screen.getByText('Chunking: test-file.txt')).toBeInTheDocument();
    expect(screen.getByText('2/5')).toBeInTheDocument();
    expect(screen.getByText('42 chunks created')).toBeInTheDocument();

    // Check progress bar value: (2/5) * 100 = 40%
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('renders embedding progress details', () => {
    const mockProgress = {
      phase: 'embedding' as const,
      current: 10,
      total: 20,
      embeddingProgress: {
        currentChunk: 'chunk-123',
        chunksProcessed: 10,
        totalChunks: 20,
        modelName: 'text-embedding-3-small',
      },
    };

    render(<ImportProgressDisplay progress={mockProgress} />);

    expect(screen.getByText('embedding')).toBeInTheDocument();
    expect(screen.getByText('Embedding: chunk-123')).toBeInTheDocument();
    expect(screen.getByText('10/20')).toBeInTheDocument();
    expect(screen.getByText('Using text-embedding-3-small')).toBeInTheDocument();

    // Check progress bar value: (10/20) * 100 = 50%
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('does not render chunking details when not in chunking phase', () => {
    const mockProgress = {
      phase: 'importing' as const,
      current: 1,
      total: 10,
    };

    render(<ImportProgressDisplay progress={mockProgress} />);

    expect(screen.queryByText(/chunking:/i)).not.toBeInTheDocument();
  });

  it('does not render embedding details when not in embedding phase', () => {
    const mockProgress = {
      phase: 'chunking' as const,
      current: 1,
      total: 10,
      chunkingProgress: {
        currentFile: 'test.txt',
        filesProcessed: 1,
        totalFiles: 10,
        chunksCreated: 5,
      },
    };

    render(<ImportProgressDisplay progress={mockProgress} />);

    expect(screen.queryByText(/embedding:/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/using/i)).not.toBeInTheDocument();
  });

  it('calls onClose when provided', () => {
    const mockOnClose = vi.fn();
    const mockProgress = {
      phase: 'importing' as const,
      current: 1,
      total: 10,
    };

    render(<ImportProgressDisplay progress={mockProgress} onClose={mockOnClose} />);

    const closeButton = screen.getByText('Close');
    closeButton.click();

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('handles complete progress correctly', () => {
    const mockProgress = {
      phase: 'chunking' as const,
      current: 5,
      total: 5,
      chunkingProgress: {
        currentFile: 'last-file.txt',
        filesProcessed: 5,
        totalFiles: 5,
        chunksCreated: 100,
      },
    };

    render(<ImportProgressDisplay progress={mockProgress} />);

    // Check progress bar shows 100%
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText('5/5')).toBeInTheDocument();
  });
});
