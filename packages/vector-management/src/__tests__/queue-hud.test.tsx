import { JobQueue, usePGliteDatabase } from '@brainstrike/db';
import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '@brainstrike/preferences';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueHud } from '../queue-hud';

vi.mock('@brainstrike/db', () => ({
  JobQueue: vi.fn(),
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteDatabase: vi.fn(),
}));

describe('QueueHud', () => {
  const mockRepairUnclaimableQueued = vi.fn();
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
    __resetVectorStatusUIStoreForTests();
    vi.stubEnv('EMBED_QUEUE_ENABLED', 'true');

    const mockJobQueue = {
      repairUnclaimableQueued: mockRepairUnclaimableQueued,
      requeueFailed: mockRequeueFailed,
    };
    mockRepairUnclaimableQueued.mockResolvedValue(0);
    mockRequeueFailed.mockResolvedValue(0);

    (JobQueue as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (
      this: Record<string, unknown>
    ) {
      Object.assign(this, mockJobQueue);
    });
  });

  const setStoreStats = (stats: {
    failed: number;
    nextRunnableAt?: string | null;
    queued: number;
    running: number;
    succeeded: number;
    succeededLifetime?: number;
  }) => {
    useVectorStatusUIStore.setState({
      durableQueueStats: {
        ...stats,
        nextRunnableAt: stats.nextRunnableAt ?? null,
        // Default the lifetime total to the live count so existing single-value
        // assertions still hold; tests that care about the distinction set both.
        succeededLifetime: stats.succeededLifetime ?? stats.succeeded,
      },
    });
  };

  const renderStatusBar = () =>
    render(
      <TooltipProvider delayDuration={0}>
        <QueueHud variant="status-bar" />
      </TooltipProvider>
    );

  it('renders when queue is enabled in browser', () => {
    vi.mocked(usePGliteDatabase).mockReturnValue(null);

    const { container } = render(<QueueHud />);
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector('button[aria-label="Retry failed jobs"]')).toBeInTheDocument();
  });

  it('renders queue stats from store', () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    setStoreStats({
      failed: 1,
      nextRunnableAt: '2025-01-01T00:00:00Z',
      queued: 5,
      running: 2,
      succeeded: 10,
    });

    render(<QueueHud />);

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

  it('shows the durable lifetime total, not the live succeeded count, as Success', () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    // Live succeeded rows get pruned during long backfills, so the card must
    // show the cumulative lifetime total instead of the transient live count.
    setStoreStats({
      failed: 0,
      queued: 0,
      running: 0,
      succeeded: 2,
      succeededLifetime: 177_355,
    });

    render(<QueueHud />);

    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText('177355')).toBeInTheDocument();
    expect(screen.queryByText('2')).not.toBeInTheDocument();
  });

  it('shows the lifetime total in the status-bar OK slot and tooltip', async () => {
    const user = userEvent.setup();
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    setStoreStats({
      failed: 0,
      queued: 0,
      running: 0,
      succeeded: 2,
      succeededLifetime: 4242,
    });

    renderStatusBar();

    const status = screen.getByRole('status', { name: /embedding queue/i });
    expect(within(status).getByText('4242')).toBeInTheDocument();

    await user.hover(status);
    await waitFor(() => {
      expect(screen.getAllByText('Success: 4242').length).toBeGreaterThan(0);
    });
  });

  it('displays zero counts when store has no stats', () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    // No store stats set — defaults to null → zeros
    render(<QueueHud />);

    const zeros = screen.getAllByText('0');
    expect(zeros).toHaveLength(4); // queued, running, failed, succeeded
  });

  it('handles retry failed jobs button click', async () => {
    const user = userEvent.setup();
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    setStoreStats({ failed: 3, queued: 0, running: 0, succeeded: 0 });

    render(<QueueHud />);

    const retryButton = screen.getByRole('button', { name: 'Retry 3 failed jobs' });
    expect(retryButton).not.toBeDisabled();

    await user.click(retryButton);

    await waitFor(() => {
      expect(mockRepairUnclaimableQueued).toHaveBeenCalledWith('embeddings', 20);
      expect(mockRequeueFailed).toHaveBeenCalledWith('embeddings', 20);
    });
  });

  it('disables retry button when no failed jobs', () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    setStoreStats({ failed: 0, queued: 0, running: 0, succeeded: 5 });

    render(<QueueHud />);

    const retryButton = screen.getByRole('button', { name: 'Retry failed jobs' });
    expect(retryButton).toBeDisabled();
  });

  it('disables retry button when jobQueue is null', () => {
    vi.mocked(usePGliteDatabase).mockReturnValue(null);

    render(<QueueHud />);

    const retryButton = screen.getByRole('button', { name: 'Retry failed jobs' });
    expect(retryButton).toBeDisabled();
  });

  it('disables button during retry and optimistically zeroes failed count', async () => {
    const user = userEvent.setup();
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    setStoreStats({ failed: 3, queued: 0, running: 0, succeeded: 0 });

    let resolveRequeue!: (value: number) => void;
    const requeuePromise = new Promise<number>((resolve) => {
      resolveRequeue = resolve;
    });

    mockRequeueFailed.mockReturnValue(requeuePromise);

    render(<QueueHud />);

    const retryButton = screen.getByRole('button', { name: /retry 3 failed jobs/i });
    expect(retryButton).not.toBeDisabled();

    await user.click(retryButton);

    // Button disabled while busy
    await waitFor(() => {
      expect(retryButton).toBeDisabled();
    });

    resolveRequeue?.(3);

    // After retry completes, failed is optimistically zeroed → queued becomes 3
    await waitFor(() => {
      expect(useVectorStatusUIStore.getState().durableQueueStats?.failed).toBe(0);
      expect(useVectorStatusUIStore.getState().durableQueueStats?.queued).toBe(3);
    });
  });

  it('does not display nextRunnableAt when not provided', () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    setStoreStats({ failed: 0, queued: 0, running: 0, succeeded: 0 });

    render(<QueueHud />);

    expect(screen.queryByText(/Next:/)).not.toBeInTheDocument();
  });

  it('renders status-bar summary with queue counts', () => {
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    setStoreStats({ failed: 3, queued: 2, running: 1, succeeded: 4 });

    renderStatusBar();

    const status = screen.getByRole('status', { name: /embedding queue/i });
    const summary = within(status);

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

  it('shows tooltip details for status-bar variant', async () => {
    const user = userEvent.setup();
    const mockDb = {} as never;
    vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);

    setStoreStats({
      failed: 0,
      nextRunnableAt: '2025-01-01T00:00:00Z',
      queued: 2,
      running: 1,
      succeeded: 4,
    });

    renderStatusBar();

    const status = screen.getByRole('status', { name: /embedding queue/i });
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

    setStoreStats({ failed: 2, queued: 0, running: 0, succeeded: 0 });

    renderStatusBar();

    const retryButton = screen.getByRole('button', { name: 'Retry 2 failed jobs' });
    expect(retryButton).not.toBeDisabled();

    await user.click(retryButton);

    await waitFor(() => {
      expect(mockRepairUnclaimableQueued).toHaveBeenCalledWith('embeddings', 20);
      expect(mockRequeueFailed).toHaveBeenCalledWith('embeddings', 20);
    });
  });
});
