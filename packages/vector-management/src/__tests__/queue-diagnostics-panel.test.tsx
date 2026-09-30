/**
 * Tests for QueueDiagnosticsPanel component (BST-166)
 */

import type { QueueHealthMetrics } from '@brainstrike/queue';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueDiagnosticsPanel } from '../queue-diagnostics-panel';
import { useQueueHealthMetrics } from '../use-queue-health-metrics';

// Mock dependencies of useQueueHealthMetrics
vi.mock('@brainstrike/db', () => ({
  JobQueue: vi.fn(),
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteDatabase: vi.fn(() => null),
}));
vi.mock('@brainstrike/db/react', () => ({
  JobQueue: vi.fn(),
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteDatabase: vi.fn(() => null),
}));

vi.mock('../embedding-queue-provider', () => ({
  useEmbeddingQueueSafe: vi.fn(() => null),
}));

vi.mock('../use-queue-health-metrics', () => ({
  useQueueHealthMetrics: vi.fn(),
}));

const createMetrics = (overrides: Partial<QueueHealthMetrics> = {}): QueueHealthMetrics => ({
  durableQueue: null,
  ephemeralQueue: null,
  lastUpdated: Date.now(),
  workerHealth: null,
  ...overrides,
});

const mockRefresh = vi.fn<() => Promise<void>>();

const renderPanel = (metrics: QueueHealthMetrics, options: { compact?: boolean } = {}) =>
  render(
    <TooltipProvider delayDuration={0}>
      <QueueDiagnosticsPanel
        compact={options.compact ?? false}
        metrics={metrics}
        showRefresh={false}
      />
    </TooltipProvider>
  );

const renderHookBackedPanel = (options: { compact?: boolean; showRefresh?: boolean } = {}) =>
  render(
    <TooltipProvider delayDuration={0}>
      <QueueDiagnosticsPanel
        compact={options.compact ?? false}
        showRefresh={options.showRefresh ?? true}
      />
    </TooltipProvider>
  );

describe('QueueDiagnosticsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefresh.mockResolvedValue(undefined);
    vi.mocked(useQueueHealthMetrics).mockReturnValue({
      error: null,
      isLoading: false,
      metrics: createMetrics(),
      refresh: mockRefresh,
    });
  });

  describe('hook-backed mode', () => {
    it('shows refresh button by default when metrics are not provided', () => {
      renderHookBackedPanel();

      expect(useQueueHealthMetrics).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Refresh metrics' })).toBeInTheDocument();
    });

    it('hides refresh button when showRefresh is false in hook-backed mode', () => {
      renderHookBackedPanel({ showRefresh: false });

      expect(screen.queryByRole('button', { name: 'Refresh metrics' })).not.toBeInTheDocument();
    });

    it('resets refresh button state after refresh completes', async () => {
      const user = userEvent.setup();
      renderHookBackedPanel();
      const refreshButton = screen.getByRole('button', { name: 'Refresh metrics' });

      await user.click(refreshButton);

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
        expect(refreshButton).not.toBeDisabled();
      });
    });

    it('ignores showRefresh when external metrics are provided', () => {
      render(
        <TooltipProvider delayDuration={0}>
          <QueueDiagnosticsPanel metrics={createMetrics()} showRefresh={true} />
        </TooltipProvider>
      );

      expect(screen.queryByRole('button', { name: 'Refresh metrics' })).not.toBeInTheDocument();
    });
  });

  describe('header and structure', () => {
    it('renders with title', () => {
      const metrics = createMetrics();
      renderPanel(metrics);

      expect(screen.getByText('Queue Diagnostics')).toBeInTheDocument();
    });

    it('shows description in non-compact mode', () => {
      const metrics = createMetrics();
      renderPanel(metrics);

      expect(
        screen.getByText('Real-time queue health and performance metrics')
      ).toBeInTheDocument();
    });

    it('hides description in compact mode', () => {
      const metrics = createMetrics();
      renderPanel(metrics, { compact: true });

      expect(
        screen.queryByText('Real-time queue health and performance metrics')
      ).not.toBeInTheDocument();
    });
  });

  describe('durable queue section', () => {
    it('shows unavailable when durableQueue is null', () => {
      const metrics = createMetrics({ durableQueue: null });
      renderPanel(metrics);

      expect(screen.getByText('Durable Queue (DB)')).toBeInTheDocument();
      expect(screen.getByText('Database not connected')).toBeInTheDocument();
    });

    it('shows connected status with stats', () => {
      const metrics = createMetrics({
        durableQueue: {
          failed: 1,
          nextRunnableAt: null,
          queued: 5,
          running: 2,
          succeeded: 100,
        },
      });
      renderPanel(metrics);

      expect(screen.getByText('Durable Queue (DB)')).toBeInTheDocument();
      expect(screen.getByText('Connected')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument(); // queued
      expect(screen.getByText('2')).toBeInTheDocument(); // running
      expect(screen.getByText('1')).toBeInTheDocument(); // failed
      expect(screen.getByText('100')).toBeInTheDocument(); // succeeded
    });

    it('displays metric labels', () => {
      const metrics = createMetrics({
        durableQueue: {
          failed: 0,
          nextRunnableAt: null,
          queued: 0,
          running: 0,
          succeeded: 0,
        },
      });
      renderPanel(metrics);

      expect(screen.getByText('Queued')).toBeInTheDocument();
      expect(screen.getByText('Running')).toBeInTheDocument();
      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.getByText('Succeeded')).toBeInTheDocument();
    });
  });

  describe('ephemeral queue section', () => {
    it('shows unavailable when ephemeralQueue is null', () => {
      const metrics = createMetrics({ ephemeralQueue: null });
      renderPanel(metrics);

      expect(screen.getByText('Ephemeral Queue (Runtime)')).toBeInTheDocument();
      expect(screen.getByText('Workerpool not initialized')).toBeInTheDocument();
    });

    it('shows connected status with metrics', () => {
      const metrics = createMetrics({
        ephemeralQueue: {
          active: 3,
          completed: 50,
          failed: 2,
          lastError: null,
          latencyAvgMs: 150,
          latencyP50Ms: 120,
          latencyP95Ms: 300,
          throughputPerMinute: 10.5,
          totalEnqueued: 55,
          windowErrorCount: 0,
        },
      });
      renderPanel(metrics);

      expect(screen.getByText('Ephemeral Queue (Runtime)')).toBeInTheDocument();
      // Check that metrics are displayed
      expect(screen.getByText('3')).toBeInTheDocument(); // active
      expect(screen.getByText('50')).toBeInTheDocument(); // completed
      expect(screen.getByText('55')).toBeInTheDocument(); // totalEnqueued
    });

    it('displays performance metrics in non-compact mode', () => {
      const metrics = createMetrics({
        ephemeralQueue: {
          active: 0,
          completed: 0,
          failed: 0,
          lastError: null,
          latencyAvgMs: 200,
          latencyP50Ms: 150,
          latencyP95Ms: 400,
          throughputPerMinute: 5.5, // < 10, so displays with 1 decimal
          totalEnqueued: 0,
          windowErrorCount: 0,
        },
      });
      renderPanel(metrics);

      expect(screen.getByText('Throughput')).toBeInTheDocument();
      expect(screen.getByText('5.5/min')).toBeInTheDocument();
      expect(screen.getByText('Avg Latency')).toBeInTheDocument();
      expect(screen.getByText('200ms')).toBeInTheDocument();
      expect(screen.getByText('P50')).toBeInTheDocument();
      expect(screen.getByText('150ms')).toBeInTheDocument();
      expect(screen.getByText('P95')).toBeInTheDocument();
      expect(screen.getByText('400ms')).toBeInTheDocument();
    });

    it('hides performance metrics in compact mode', () => {
      const metrics = createMetrics({
        ephemeralQueue: {
          active: 0,
          completed: 0,
          failed: 0,
          lastError: null,
          latencyAvgMs: 200,
          latencyP50Ms: 150,
          latencyP95Ms: 400,
          throughputPerMinute: 10,
          totalEnqueued: 0,
          windowErrorCount: 0,
        },
      });
      renderPanel(metrics, { compact: true });

      expect(screen.queryByText('Throughput')).not.toBeInTheDocument();
      expect(screen.queryByText('Avg Latency')).not.toBeInTheDocument();
    });

    it('shows last error when present', () => {
      const metrics = createMetrics({
        ephemeralQueue: {
          active: 0,
          completed: 0,
          failed: 1,
          lastError: 'Worker crashed unexpectedly',
          latencyAvgMs: null,
          latencyP50Ms: null,
          latencyP95Ms: null,
          throughputPerMinute: 0,
          totalEnqueued: 1,
          windowErrorCount: 1,
        },
      });
      renderPanel(metrics);

      expect(screen.getByText('Worker crashed unexpectedly')).toBeInTheDocument();
    });
  });

  describe('worker health section', () => {
    it('does not show worker health when null', () => {
      const metrics = createMetrics({ workerHealth: null });
      renderPanel(metrics);

      expect(screen.queryByText('Worker Status')).not.toBeInTheDocument();
    });

    it('shows worker status when available', () => {
      const metrics = createMetrics({
        workerHealth: {
          error: null,
          isReady: true,
          state: 'ready',
        },
      });
      renderPanel(metrics);

      expect(screen.getByText('Worker Status')).toBeInTheDocument();
      expect(screen.getByText('ready')).toBeInTheDocument();
    });
  });

  describe('status indicators', () => {
    it('shows success indicator when no errors and no active tasks', () => {
      const metrics = createMetrics({
        durableQueue: {
          failed: 0,
          nextRunnableAt: null,
          queued: 0,
          running: 0,
          succeeded: 10,
        },
        ephemeralQueue: {
          active: 0,
          completed: 10,
          failed: 0,
          lastError: null,
          latencyAvgMs: null,
          latencyP50Ms: null,
          latencyP95Ms: null,
          throughputPerMinute: 0,
          totalEnqueued: 10,
          windowErrorCount: 0,
        },
      });
      renderPanel(metrics);

      // The CheckCircle2 icon should be present (semantic success state)
      const icon = document.querySelector('svg.text-success');
      expect(icon).toBeInTheDocument();
    });

    it('shows warning indicator when there are failed tasks', () => {
      const metrics = createMetrics({
        durableQueue: {
          failed: 5,
          nextRunnableAt: null,
          queued: 0,
          running: 0,
          succeeded: 10,
        },
      });
      renderPanel(metrics);

      // The AlertTriangle icon should be present (semantic warning state)
      const icon = document.querySelector('svg.text-warning');
      expect(icon).toBeInTheDocument();
    });

    it('shows active indicator when tasks are running', () => {
      const metrics = createMetrics({
        durableQueue: {
          failed: 0,
          nextRunnableAt: null,
          queued: 2,
          running: 3,
          succeeded: 10,
        },
        ephemeralQueue: {
          active: 1,
          completed: 0,
          failed: 0,
          lastError: null,
          latencyAvgMs: 100,
          latencyP50Ms: 80,
          latencyP95Ms: 200,
          throughputPerMinute: 5,
          totalEnqueued: 1,
          windowErrorCount: 0,
        },
      });
      renderPanel(metrics);

      // The Zap icon should be present (semantic informational state)
      const icon = document.querySelector('svg.text-info');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('latency formatting', () => {
    it('formats latency under 1 second as milliseconds', () => {
      const metrics = createMetrics({
        ephemeralQueue: {
          active: 0,
          completed: 0,
          failed: 0,
          lastError: null,
          latencyAvgMs: 500,
          latencyP50Ms: 450,
          latencyP95Ms: 800,
          throughputPerMinute: 0,
          totalEnqueued: 0,
          windowErrorCount: 0,
        },
      });
      renderPanel(metrics);

      expect(screen.getByText('500ms')).toBeInTheDocument();
      expect(screen.getByText('450ms')).toBeInTheDocument();
      expect(screen.getByText('800ms')).toBeInTheDocument();
    });

    it('formats latency over 1 second as seconds', () => {
      const metrics = createMetrics({
        ephemeralQueue: {
          active: 0,
          completed: 0,
          failed: 0,
          lastError: null,
          latencyAvgMs: 2500,
          latencyP50Ms: 1500,
          latencyP95Ms: 5000,
          throughputPerMinute: 0,
          totalEnqueued: 0,
          windowErrorCount: 0,
        },
      });
      renderPanel(metrics);

      expect(screen.getByText('2.5s')).toBeInTheDocument();
      expect(screen.getByText('1.5s')).toBeInTheDocument();
      expect(screen.getByText('5.0s')).toBeInTheDocument();
    });

    it('shows dash for null latencies', () => {
      const metrics = createMetrics({
        ephemeralQueue: {
          active: 0,
          completed: 0,
          failed: 0,
          lastError: null,
          latencyAvgMs: null,
          latencyP50Ms: null,
          latencyP95Ms: null,
          throughputPerMinute: 0,
          totalEnqueued: 0,
          windowErrorCount: 0,
        },
      });
      renderPanel(metrics);

      // Should show "—" for null latencies
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBe(3);
    });
  });

  describe('throughput formatting', () => {
    it('formats low throughput with one decimal', () => {
      const metrics = createMetrics({
        ephemeralQueue: {
          active: 0,
          completed: 0,
          failed: 0,
          lastError: null,
          latencyAvgMs: null,
          latencyP50Ms: null,
          latencyP95Ms: null,
          throughputPerMinute: 2.5,
          totalEnqueued: 0,
          windowErrorCount: 0,
        },
      });
      renderPanel(metrics);

      expect(screen.getByText('2.5/min')).toBeInTheDocument();
    });

    it('formats high throughput as integer', () => {
      const metrics = createMetrics({
        ephemeralQueue: {
          active: 0,
          completed: 0,
          failed: 0,
          lastError: null,
          latencyAvgMs: null,
          latencyP50Ms: null,
          latencyP95Ms: null,
          throughputPerMinute: 45.7,
          totalEnqueued: 0,
          windowErrorCount: 0,
        },
      });
      renderPanel(metrics);

      expect(screen.getByText('46/min')).toBeInTheDocument();
    });

    it('formats zero throughput', () => {
      const metrics = createMetrics({
        ephemeralQueue: {
          active: 0,
          completed: 0,
          failed: 0,
          lastError: null,
          latencyAvgMs: null,
          latencyP50Ms: null,
          latencyP95Ms: null,
          throughputPerMinute: 0,
          totalEnqueued: 0,
          windowErrorCount: 0,
        },
      });
      renderPanel(metrics);

      expect(screen.getByText('0/min')).toBeInTheDocument();
    });
  });

  describe('last updated', () => {
    it('shows last updated time when available', () => {
      const timestamp = new Date('2025-01-01T12:00:00').getTime();
      const metrics = createMetrics({
        durableQueue: {
          failed: 0,
          nextRunnableAt: null,
          queued: 0,
          running: 0,
          succeeded: 0,
        },
        lastUpdated: timestamp,
      });
      renderPanel(metrics);

      expect(screen.getByText(/Updated:/)).toBeInTheDocument();
    });

    it('does not label ephemeral-only metrics with durable poll freshness', () => {
      const metrics = createMetrics({
        durableQueue: null,
        lastUpdated: new Date('2025-01-01T12:00:00').getTime(),
      });
      renderPanel(metrics);

      expect(screen.queryByText(/Updated:/)).not.toBeInTheDocument();
    });

    it('does not show last updated when zero', () => {
      const metrics = createMetrics({
        lastUpdated: 0,
      });
      renderPanel(metrics);

      expect(screen.queryByText(/Updated:/)).not.toBeInTheDocument();
    });
  });
});
