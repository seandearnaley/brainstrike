import { JobQueue, usePGliteDatabase } from '@brainstrike/db';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueHud } from '../queue-hud';

vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: vi.fn(),
  JobQueue: vi.fn(),
}));

describe('QueueHud', () => {
  const mockGetQueueStats = vi.fn();
  const mockRequeueFailed = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('EMBED_QUEUE_ENABLED', 'true');

    const mockJobQueue = {
      getQueueStats: mockGetQueueStats,
      requeueFailed: mockRequeueFailed,
    };

    vi.mocked(JobQueue).mockImplementation(() => mockJobQueue as never);
  });

  it('renders when queue is enabled in browser', () => {
    // In browser environment, queue is always considered enabled
    vi.mocked(usePGliteDatabase).mockReturnValue(null);

    const { container } = render(<QueueHud />);
    // Should render the queue HUD (not null) since we're in a browser context
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector('button[aria-label="Retry failed jobs"]')).toBeInTheDocument();
  });

  it('renders queue stats when enabled', async () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    mockGetQueueStats.mockResolvedValue([
      {
        queue: 'embeddings',
        queued: 5,
        running: 2,
        failed: 1,
        succeeded: 10,
        nextRunnableAt: '2025-01-01T00:00:00Z',
      },
    ]);

    render(<QueueHud />);

    await waitFor(() => {
      expect(screen.getByText('5')).toBeInTheDocument();
    });

    expect(screen.getByText('Queue')).toBeInTheDocument();
    expect(screen.getByText('embeddings')).toBeInTheDocument();
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText(/2025-01-01T00:00:00Z/)).toBeInTheDocument();
  });

  it('displays zero counts when stats are null', async () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    mockGetQueueStats.mockResolvedValue([]);

    render(<QueueHud />);

    await waitFor(() => {
      expect(screen.getByText('Queued')).toBeInTheDocument();
    });

    // Should show 0 for all stats
    const zeros = screen.getAllByText('0');
    expect(zeros).toHaveLength(4); // queued, running, failed, succeeded
  });

  it('handles retry failed jobs button click', async () => {
    const user = userEvent.setup();
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    mockGetQueueStats.mockResolvedValue([
      {
        queue: 'embeddings',
        queued: 0,
        running: 0,
        failed: 3,
        succeeded: 0,
      },
    ]);

    render(<QueueHud />);

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    const retryButton = screen.getByRole('button', { name: /retry failed/i });
    expect(retryButton).not.toBeDisabled();

    await user.click(retryButton);

    await waitFor(() => {
      expect(mockRequeueFailed).toHaveBeenCalledWith('embeddings', 20);
    });
  });

  it('disables retry button when no failed jobs', async () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    mockGetQueueStats.mockResolvedValue([
      {
        queue: 'embeddings',
        queued: 0,
        running: 0,
        failed: 0,
        succeeded: 5,
      },
    ]);

    render(<QueueHud />);

    await waitFor(() => {
      expect(screen.getByText('5')).toBeInTheDocument();
    });

    const retryButton = screen.getByRole('button', { name: /retry failed/i });
    expect(retryButton).toBeDisabled();
  });

  it('disables retry button when jobQueue is null', () => {
    vi.mocked(usePGliteDatabase).mockReturnValue(null);

    render(<QueueHud />);

    const retryButton = screen.getByRole('button', { name: /retry failed/i });
    expect(retryButton).toBeDisabled();
  });

  it('handles errors during stats fetch gracefully', async () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    mockGetQueueStats.mockRejectedValue(new Error('Failed to fetch stats'));

    render(<QueueHud />);

    // Should not crash and should render with zeros
    await waitFor(() => {
      expect(screen.getByText('Queue')).toBeInTheDocument();
    });

    const zeros = screen.getAllByText('0');
    expect(zeros).toHaveLength(4);
  });

  it('updates stats periodically', async () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    let callCount = 0;
    mockGetQueueStats.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [
          {
            queue: 'embeddings',
            queued: 1,
            running: 0,
            failed: 0,
            succeeded: 0,
          },
        ];
      }
      return [
        {
          queue: 'embeddings',
          queued: 0,
          running: 1,
          failed: 0,
          succeeded: 0,
        },
      ];
    });

    render(<QueueHud />);

    await waitFor(() => {
      expect(screen.getByText('1')).toBeInTheDocument();
    });

    // Wait for the interval to trigger (2000ms)
    await waitFor(
      () => {
        expect(mockGetQueueStats).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 }
    );
  });

  it('cleans up interval on unmount', async () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    mockGetQueueStats.mockResolvedValue([
      {
        queue: 'embeddings',
        queued: 0,
        running: 0,
        failed: 0,
        succeeded: 0,
      },
    ]);

    const { unmount } = render(<QueueHud />);

    await waitFor(() => {
      expect(mockGetQueueStats).toHaveBeenCalledTimes(1);
    });

    const callCountBeforeUnmount = mockGetQueueStats.mock.calls.length;

    unmount();

    // Wait a bit longer than the interval
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Should not have been called again after unmount
    expect(mockGetQueueStats).toHaveBeenCalledTimes(callCountBeforeUnmount);
  });

  it('updates button state during retry operation', async () => {
    const user = userEvent.setup();
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    mockGetQueueStats.mockResolvedValue([
      {
        queue: 'embeddings',
        queued: 0,
        running: 0,
        failed: 3,
        succeeded: 0,
      },
    ]);

    let resolveRequeue: () => void;
    const requeuePromise = new Promise<void>((resolve) => {
      resolveRequeue = resolve;
    });

    mockRequeueFailed.mockReturnValue(requeuePromise);

    render(<QueueHud />);

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    const retryButton = screen.getByRole('button', { name: /retry failed/i });
    expect(retryButton).not.toBeDisabled();

    // Start the retry operation
    await user.click(retryButton);

    // Button should be disabled while operation is in progress
    await waitFor(() => {
      expect(retryButton).toBeDisabled();
    });

    // Complete the operation
    resolveRequeue?.();

    // Button should be re-enabled after operation completes
    await waitFor(() => {
      expect(retryButton).not.toBeDisabled();
    });
  });

  it('does not display nextRunnableAt when not provided', async () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    mockGetQueueStats.mockResolvedValue([
      {
        queue: 'embeddings',
        queued: 0,
        running: 0,
        failed: 0,
        succeeded: 0,
      },
    ]);

    render(<QueueHud />);

    await waitFor(() => {
      expect(screen.getByText('Queue')).toBeInTheDocument();
    });

    expect(screen.queryByText(/Next:/)).not.toBeInTheDocument();
  });
});
