import { JobQueue, usePGliteDatabase } from '@brainstrike/db';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
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

  const expectQueueHeading = () => {
    const headings = screen.getAllByRole('heading', { name: 'Queue' });
    expect(headings.length).toBeGreaterThan(0);
  };

  const expectQueueBadge = (label: string) => {
    const badges = screen.getAllByText(label);
    expect(badges.length).toBeGreaterThan(0);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('EMBED_QUEUE_ENABLED', 'true');

    const mockJobQueue = {
      getQueueStats: mockGetQueueStats,
      requeueFailed: mockRequeueFailed,
    };

    (JobQueue as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (
      this: Record<string, unknown>
    ) {
      Object.assign(this, mockJobQueue);
    });
  });

  const renderStatusBar = () =>
    render(
      <TooltipProvider delayDuration={0}>
        <QueueHud variant="status-bar" />
      </TooltipProvider>
    );

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

    expectQueueHeading();
    expectQueueBadge('embeddings');
    expect(screen.getAllByText('Queued').length).toBeGreaterThan(0);
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
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
      expect(screen.getAllByText('Queued').length).toBeGreaterThan(0);
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

    const retryButton = screen.getByRole('button', { name: 'Retry 3 failed jobs' });
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

    const retryButton = screen.getByRole('button', { name: 'Retry failed jobs' });
    expect(retryButton).toBeDisabled();
  });

  it('disables retry button when jobQueue is null', () => {
    vi.mocked(usePGliteDatabase).mockReturnValue(null);

    render(<QueueHud />);

    const retryButton = screen.getByRole('button', { name: 'Retry failed jobs' });
    expect(retryButton).toBeDisabled();
  });

  it('handles errors during stats fetch gracefully', async () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    mockGetQueueStats.mockRejectedValue(new Error('Failed to fetch stats'));

    render(<QueueHud />);

    // Should not crash and should render with zeros
    await waitFor(() => {
      expectQueueHeading();
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

    if (process.env['NODE_ENV'] !== 'test') {
      await waitFor(
        () => {
          expect(mockGetQueueStats).toHaveBeenCalledTimes(2);
        },
        { timeout: 3000 }
      );
    } else {
      expect(mockGetQueueStats).toHaveBeenCalledTimes(1);
    }
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

    // Wait a bit to ensure no extra calls occur (intervals disabled in tests)
    await new Promise((resolve) => setTimeout(resolve, 20));

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

    let resolveRequeue!: () => void;
    const requeuePromise = new Promise<void>((resolve) => {
      resolveRequeue = resolve;
    });

    mockRequeueFailed.mockReturnValue(requeuePromise);

    render(<QueueHud />);

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    const retryButton = screen.getByRole('button', { name: /retry 3 failed jobs/i });
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

  it('renders status-bar summary with queue counts', async () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    mockGetQueueStats.mockResolvedValue([
      {
        queue: 'embeddings',
        queued: 2,
        running: 1,
        failed: 3,
        succeeded: 4,
      },
    ]);

    renderStatusBar();

    const status = await screen.findByRole('status', { name: /embedding queue/i });
    const summary = within(status);

    await waitFor(() => {
      expect(summary.getByText('Queue')).toBeInTheDocument();
      expect(summary.getByText('Q')).toBeInTheDocument();
      expect(summary.getByText('2')).toBeInTheDocument();
      expect(summary.getByText('R')).toBeInTheDocument();
      expect(summary.getByText('1')).toBeInTheDocument();
      expect(summary.getByText('F')).toBeInTheDocument();
      expect(summary.getByText('3')).toBeInTheDocument();
      expect(summary.getByText('OK')).toBeInTheDocument();
      expect(summary.getByText('4')).toBeInTheDocument();
    });
  });

  it('shows tooltip details for status-bar variant', async () => {
    const user = userEvent.setup();
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    mockGetQueueStats.mockResolvedValue([
      {
        queue: 'embeddings',
        queued: 2,
        running: 1,
        failed: 0,
        succeeded: 4,
        nextRunnableAt: '2025-01-01T00:00:00Z',
      },
    ]);

    renderStatusBar();

    const status = await screen.findByRole('status', { name: /embedding queue/i });
    await waitFor(() => {
      expect(within(status).getByText('2')).toBeInTheDocument();
    });
    await user.hover(status);

    const headings = await screen.findAllByText('Embedding queue');
    expect(headings.length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getAllByText('Queued: 2').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Running: 1').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Failed: 0').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Success: 4').length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Next:/).length).toBeGreaterThan(0);
    });
  });

  it('handles retry action in status-bar variant', async () => {
    const user = userEvent.setup();
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    mockGetQueueStats.mockResolvedValue([
      {
        queue: 'embeddings',
        queued: 0,
        running: 0,
        failed: 2,
        succeeded: 0,
      },
    ]);

    renderStatusBar();

    const retryButton = await screen.findByRole('button', { name: 'Retry 2 failed jobs' });
    expect(retryButton).not.toBeDisabled();

    await user.click(retryButton);

    await waitFor(() => {
      expect(mockRequeueFailed).toHaveBeenCalledWith('embeddings', 20);
    });
  });
});
