/**
 * Tests for QueueStatusPopover component (BST-166)
 */

import type { QueueHealthMetrics } from '@brainstrike/queue';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueStatusPopover } from '../queue-status-popover';

// Mock the hook
vi.mock('../use-queue-health-metrics', () => ({
  useQueueHealthMetrics: vi.fn(),
}));

// Mock dependencies of useQueueHealthMetrics (in case it's called)
vi.mock('@brainstrike/db', () => ({
  JobQueue: vi.fn(),
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useBrainstrikeDbClient: vi.fn(() => null),
}));

vi.mock('../embedding-queue-provider', () => ({
  useEmbeddingQueueSafe: vi.fn(() => null),
}));

import { useQueueHealthMetrics } from '../use-queue-health-metrics';

const createMetrics = (overrides: Partial<QueueHealthMetrics> = {}): QueueHealthMetrics => ({
  durableQueue: null,
  ephemeralQueue: null,
  workerHealth: null,
  lastUpdated: Date.now(),
  ...overrides,
});

const renderPopover = () =>
  render(
    <TooltipProvider delayDuration={0}>
      <QueueStatusPopover />
    </TooltipProvider>
  );

describe('QueueStatusPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('default state', () => {
    it('renders compact status when metrics are available', () => {
      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics(),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      // Should render the trigger button (not a loading indicator)
      expect(screen.getByTestId('queue-status-popover-trigger')).toBeInTheDocument();
    });
  });

  describe('compact status display', () => {
    it('renders trigger with queue metrics', () => {
      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 5,
            running: 2,
            failed: 1,
            succeeded: 100,
            nextRunnableAt: null,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      // Check for metric labels
      expect(screen.getByText('Q')).toBeInTheDocument();
      expect(screen.getByText('R')).toBeInTheDocument();
      expect(screen.getByText('F')).toBeInTheDocument();

      // Check for metric values
      expect(screen.getByText('5')).toBeInTheDocument(); // queued
      expect(screen.getByText('2')).toBeInTheDocument(); // running
      expect(screen.getByText('1')).toBeInTheDocument(); // failed
    });

    it('shows combined running count from durable and ephemeral queues', () => {
      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 3,
            running: 2,
            failed: 0,
            succeeded: 50,
            nextRunnableAt: null,
          },
          ephemeralQueue: {
            active: 3,
            completed: 10,
            failed: 0,
            totalEnqueued: 13,
            lastError: null,
            throughputPerMinute: 5,
            latencyAvgMs: null,
            latencyP50Ms: null,
            latencyP95Ms: null,
            windowErrorCount: 0,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      // Running should be 2 + 3 = 5
      expect(screen.getByText('5')).toBeInTheDocument();
    });

    it('has accessible aria attributes', () => {
      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 3,
            running: 1,
            failed: 2,
            succeeded: 10,
            nextRunnableAt: null,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      const trigger = screen.getByRole('button');
      expect(trigger).toHaveAttribute('aria-label', 'Queue status: 3 queued, 1 running, 2 failed');
      expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    });
  });

  describe('status indicators', () => {
    it('shows success indicator when no errors and no active tasks', () => {
      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 0,
            running: 0,
            failed: 0,
            succeeded: 100,
            nextRunnableAt: null,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      // CheckCircle2 icon should be present (green)
      const icon = document.querySelector('.text-green-500');
      expect(icon).toBeInTheDocument();
    });

    it('shows active indicator when tasks are running', () => {
      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 5,
            running: 3,
            failed: 0,
            succeeded: 10,
            nextRunnableAt: null,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      // Zap icon should be present (blue, animated)
      const icon = document.querySelector('.text-blue-500.animate-pulse');
      expect(icon).toBeInTheDocument();
    });

    it('shows warning indicator when there are failed tasks', () => {
      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 0,
            running: 0,
            failed: 5,
            succeeded: 10,
            nextRunnableAt: null,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      // AlertTriangle icon should be present (yellow)
      const icon = document.querySelector('.text-yellow-500');
      expect(icon).toBeInTheDocument();
    });

    it('shows warning indicator when ephemeral queue has lastError', () => {
      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          ephemeralQueue: {
            active: 0,
            completed: 0,
            failed: 0,
            totalEnqueued: 1,
            lastError: 'Worker crashed',
            throughputPerMinute: 0,
            latencyAvgMs: null,
            latencyP50Ms: null,
            latencyP95Ms: null,
            windowErrorCount: 1,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      // AlertTriangle icon should be present (yellow)
      const icon = document.querySelector('.text-yellow-500');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('popover interaction', () => {
    it('opens popover on click', async () => {
      const user = userEvent.setup();

      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 3,
            running: 1,
            failed: 0,
            succeeded: 50,
            nextRunnableAt: null,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      const trigger = screen.getByTestId('queue-status-popover-trigger');
      await user.click(trigger);

      // Popover header should appear
      await waitFor(() => {
        expect(screen.getByText('Queue Status')).toBeInTheDocument();
      });
    });

    it('shows "All systems operational" badge when no issues', async () => {
      const user = userEvent.setup();

      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 0,
            running: 0,
            failed: 0,
            succeeded: 100,
            nextRunnableAt: null,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      const trigger = screen.getByTestId('queue-status-popover-trigger');
      await user.click(trigger);

      // The badge in the PopoverHeader shows the status
      await waitFor(() => {
        const badges = screen.getAllByText('All systems operational');
        // At least one badge should be present (PopoverHeader)
        expect(badges.length).toBeGreaterThan(0);
      });
    });

    it('shows "Processing active" badge when running', async () => {
      const user = userEvent.setup();

      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 5,
            running: 2,
            failed: 0,
            succeeded: 10,
            nextRunnableAt: null,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      const trigger = screen.getByTestId('queue-status-popover-trigger');
      await user.click(trigger);

      await waitFor(() => {
        expect(screen.getByText('Processing active')).toBeInTheDocument();
      });
    });

    it('shows "Issues detected" badge when errors exist', async () => {
      const user = userEvent.setup();

      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 0,
            running: 0,
            failed: 3,
            succeeded: 10,
            nextRunnableAt: null,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      const trigger = screen.getByTestId('queue-status-popover-trigger');
      await user.click(trigger);

      await waitFor(() => {
        expect(screen.getByText('Issues detected')).toBeInTheDocument();
      });
    });

    it('renders QueueDiagnosticsPanel in popover', async () => {
      const user = userEvent.setup();

      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 5,
            running: 2,
            failed: 1,
            succeeded: 100,
            nextRunnableAt: null,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      const trigger = screen.getByTestId('queue-status-popover-trigger');
      await user.click(trigger);

      await waitFor(() => {
        // The QueueDiagnosticsPanel title
        expect(screen.getByText('Queue Diagnostics')).toBeInTheDocument();
        // Section headers from the panel
        expect(screen.getByText('Durable Queue (DB)')).toBeInTheDocument();
      });
    });

    it('closes popover when clicked again', async () => {
      const user = userEvent.setup();

      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 3,
            running: 0,
            failed: 0,
            succeeded: 50,
            nextRunnableAt: null,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      const trigger = screen.getByTestId('queue-status-popover-trigger');

      // Open
      await user.click(trigger);
      await waitFor(() => {
        expect(screen.getByText('Queue Status')).toBeInTheDocument();
      });

      // Close
      await user.click(trigger);
      await waitFor(() => {
        expect(screen.queryByText('Queue Status')).not.toBeInTheDocument();
      });
    });
  });

  describe('keyboard accessibility', () => {
    it('trigger is focusable with keyboard', () => {
      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 0,
            running: 0,
            failed: 0,
            succeeded: 0,
            nextRunnableAt: null,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      // Native button elements are focusable by default (no tabIndex needed)
      const trigger = screen.getByRole('button');
      expect(trigger.tagName).toBe('BUTTON');
      // Button should not have tabIndex -1 (which would disable focus)
      expect(trigger.getAttribute('tabIndex')).not.toBe('-1');
    });
  });

  describe('combined failed count', () => {
    it('sums failed from both durable and ephemeral queues', () => {
      vi.mocked(useQueueHealthMetrics).mockReturnValue({
        metrics: createMetrics({
          durableQueue: {
            queued: 0,
            running: 0,
            failed: 3,
            succeeded: 10,
            nextRunnableAt: null,
          },
          ephemeralQueue: {
            active: 0,
            completed: 5,
            failed: 2,
            totalEnqueued: 7,
            lastError: null,
            throughputPerMinute: 0,
            latencyAvgMs: null,
            latencyP50Ms: null,
            latencyP95Ms: null,
            windowErrorCount: 0,
          },
        }),
        isLoading: false,
        refresh: vi.fn(),
        error: null,
      });

      renderPopover();

      // Warning icon should appear (has errors)
      const icon = document.querySelector('.text-yellow-500');
      expect(icon).toBeInTheDocument();
    });
  });
});
