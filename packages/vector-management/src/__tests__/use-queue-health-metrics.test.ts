/**
 * Tests for useQueueHealthMetrics hook (BST-166)
 */

import { JobQueue, usePGliteDatabase } from '@brainstrike/db';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmbeddingQueueSafe } from '../embedding-queue-provider';
import { useQueueHealthMetrics } from '../use-queue-health-metrics';

vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: vi.fn(),
  JobQueue: vi.fn(),
}));

vi.mock('../embedding-queue-provider', () => ({
  useEmbeddingQueueSafe: vi.fn(),
}));

describe('useQueueHealthMetrics', () => {
  const mockGetQueueStats = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    const mockJobQueue = {
      getQueueStats: mockGetQueueStats,
    };

    (JobQueue as unknown as ReturnType<typeof vi.fn>).mockImplementation(function (
      this: Record<string, unknown>
    ) {
      Object.assign(this, mockJobQueue);
    });
  });

  describe('initial state', () => {
    it('returns loading state initially', () => {
      vi.mocked(usePGliteDatabase).mockReturnValue(null);
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      const { result, unmount } = renderHook(() => useQueueHealthMetrics({ enablePolling: false }));

      expect(result.current.isLoading).toBe(true);
      expect(result.current.error).toBeNull();
      unmount();
    });

    it('returns empty metrics initially', () => {
      vi.mocked(usePGliteDatabase).mockReturnValue(null);
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      const { result, unmount } = renderHook(() => useQueueHealthMetrics({ enablePolling: false }));

      expect(result.current.metrics.durableQueue).toBeNull();
      expect(result.current.metrics.ephemeralQueue).toBeNull();
      expect(result.current.metrics.workerHealth).toBeNull();
      unmount();
    });
  });

  describe('durable queue metrics', () => {
    it('fetches stats from JobQueue when db is available', async () => {
      const mockDb = {} as never;
      vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      mockGetQueueStats.mockResolvedValue([
        {
          queue: 'embeddings',
          queued: 5,
          running: 2,
          failed: 1,
          succeeded: 100,
          nextRunnableAt: '2025-01-01T00:00:00Z',
        },
      ]);

      const { result } = renderHook(() => useQueueHealthMetrics({ enablePolling: false }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.durableQueue).toEqual({
        queued: 5,
        running: 2,
        failed: 1,
        succeeded: 100,
        nextRunnableAt: '2025-01-01T00:00:00Z',
      });
    });

    it('returns null durableQueue when db is not available', async () => {
      vi.mocked(usePGliteDatabase).mockReturnValue(null);
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      const { result } = renderHook(() => useQueueHealthMetrics({ enablePolling: false }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.durableQueue).toBeNull();
      expect(mockGetQueueStats).not.toHaveBeenCalled();
    });

    it('returns zero counts when no queue stats exist', async () => {
      const mockDb = {} as never;
      vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      mockGetQueueStats.mockResolvedValue([]);

      const { result } = renderHook(() => useQueueHealthMetrics({ enablePolling: false }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.durableQueue).toEqual({
        queued: 0,
        running: 0,
        failed: 0,
        succeeded: 0,
        nextRunnableAt: null,
      });
    });

    it('handles errors during fetch gracefully', async () => {
      const mockDb = {} as never;
      vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      mockGetQueueStats.mockRejectedValue(new Error('Database error'));

      const { result } = renderHook(() => useQueueHealthMetrics({ enablePolling: false }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Should return null for durableQueue on error, not crash
      expect(result.current.metrics.durableQueue).toBeNull();
    });
  });

  describe('ephemeral queue metrics', () => {
    it('gets metrics from EmbeddingQueueProvider when available', async () => {
      vi.mocked(usePGliteDatabase).mockReturnValue(null);
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue({
        queue: {} as never,
        metrics: {
          active: 3,
          completed: 50,
          failed: 2,
          totalEnqueued: 55,
          lastError: null,
          progress: {},
          throughputPerMinute: 10.5,
          latencyAvgMs: 150,
          latencyP50Ms: 120,
          latencyP95Ms: 300,
          windowErrorCount: 0,
        },
      });

      const { result } = renderHook(() => useQueueHealthMetrics({ enablePolling: false }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.ephemeralQueue).toEqual({
        active: 3,
        completed: 50,
        failed: 2,
        totalEnqueued: 55,
        lastError: null,
        progress: {},
        throughputPerMinute: 10.5,
        latencyAvgMs: 150,
        latencyP50Ms: 120,
        latencyP95Ms: 300,
        windowErrorCount: 0,
      });
    });

    it('returns null ephemeralQueue when not in provider', async () => {
      vi.mocked(usePGliteDatabase).mockReturnValue(null);
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      const { result } = renderHook(() => useQueueHealthMetrics({ enablePolling: false }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.ephemeralQueue).toBeNull();
    });
  });

  describe('worker health', () => {
    it('returns ready state when ephemeral queue is available', async () => {
      vi.mocked(usePGliteDatabase).mockReturnValue(null);
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue({
        queue: {} as never,
        metrics: {
          active: 0,
          completed: 0,
          failed: 0,
          totalEnqueued: 0,
          lastError: null,
          progress: {},
          throughputPerMinute: 0,
          latencyAvgMs: null,
          latencyP50Ms: null,
          latencyP95Ms: null,
          windowErrorCount: 0,
        },
      });

      const { result } = renderHook(() => useQueueHealthMetrics({ enablePolling: false }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.workerHealth).toEqual({
        state: 'ready',
        isReady: true,
        error: null,
      });
    });

    it('returns null when ephemeral queue is not available', async () => {
      vi.mocked(usePGliteDatabase).mockReturnValue(null);
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      const { result } = renderHook(() => useQueueHealthMetrics({ enablePolling: false }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.workerHealth).toBeNull();
    });
  });

  describe('refresh', () => {
    it('updates metrics when refresh is called', async () => {
      const mockDb = {} as never;
      vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      let callCount = 0;
      mockGetQueueStats.mockImplementation(async () => {
        callCount++;
        return [
          {
            queue: 'embeddings',
            queued: callCount,
            running: 0,
            failed: 0,
            succeeded: 0,
          },
        ];
      });

      const { result } = renderHook(() => useQueueHealthMetrics({ enablePolling: false }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.durableQueue?.queued).toBe(1);

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.metrics.durableQueue?.queued).toBe(2);
    });
  });

  describe('lastUpdated', () => {
    it('updates lastUpdated timestamp after fetch', async () => {
      vi.mocked(usePGliteDatabase).mockReturnValue(null);
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      const before = Date.now();

      const { result } = renderHook(() => useQueueHealthMetrics({ enablePolling: false }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const after = Date.now();

      expect(result.current.metrics.lastUpdated).toBeGreaterThanOrEqual(before);
      expect(result.current.metrics.lastUpdated).toBeLessThanOrEqual(after);
    });
  });

  describe('combined metrics', () => {
    it('consolidates metrics from all sources', async () => {
      const mockDb = {} as never;
      vi.mocked(usePGliteDatabase).mockReturnValue(mockDb);
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue({
        queue: {} as never,
        metrics: {
          active: 2,
          completed: 10,
          failed: 1,
          totalEnqueued: 13,
          lastError: null,
          progress: {},
          throughputPerMinute: 5,
          latencyAvgMs: 100,
          latencyP50Ms: 80,
          latencyP95Ms: 200,
          windowErrorCount: 0,
        },
      });

      mockGetQueueStats.mockResolvedValue([
        {
          queue: 'embeddings',
          queued: 5,
          running: 2,
          failed: 1,
          succeeded: 100,
        },
      ]);

      const { result } = renderHook(() => useQueueHealthMetrics({ enablePolling: false }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Should have all three sources populated
      expect(result.current.metrics.durableQueue).not.toBeNull();
      expect(result.current.metrics.ephemeralQueue).not.toBeNull();
      expect(result.current.metrics.workerHealth).not.toBeNull();

      // Verify specific values
      expect(result.current.metrics.durableQueue?.queued).toBe(5);
      expect(result.current.metrics.ephemeralQueue?.active).toBe(2);
      expect(result.current.metrics.workerHealth?.isReady).toBe(true);
    });
  });
});
