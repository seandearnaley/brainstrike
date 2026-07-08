/**
 * Tests for useQueueHealthMetrics hook (BST-166, BST-359)
 *
 * BST-359: Durable stats now come from the shared Zustand store
 * instead of polling the DB directly.
 */

import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '@brainstrike/preferences';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmbeddingQueueSafe } from '../embedding-queue-provider';
import { useQueueHealthMetrics } from '../use-queue-health-metrics';

vi.mock('../embedding-queue-provider', () => ({
  useEmbeddingQueueSafe: vi.fn(),
}));

describe('useQueueHealthMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetVectorStatusUIStoreForTests();
  });

  describe('initial state', () => {
    it('is never loading — metrics are derived reactively', () => {
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      const { result, unmount } = renderHook(() => useQueueHealthMetrics());

      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
      unmount();
    });

    it('returns null metrics when store has no data', async () => {
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      const { result, unmount } = renderHook(() => useQueueHealthMetrics());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.durableQueue).toBeNull();
      expect(result.current.metrics.ephemeralQueue).toBeNull();
      expect(result.current.metrics.workerHealth).toBeNull();
      unmount();
    });
  });

  describe('durable queue metrics', () => {
    it('reads stats from the shared store', async () => {
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      useVectorStatusUIStore.setState({
        durableQueueStats: {
          failed: 1,
          nextRunnableAt: '2025-01-01T00:00:00Z',
          queued: 5,
          running: 2,
          succeeded: 100,
          succeededLifetime: 100,
        },
      });

      const { result } = renderHook(() => useQueueHealthMetrics());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.durableQueue).toEqual({
        failed: 1,
        nextRunnableAt: '2025-01-01T00:00:00Z',
        queued: 5,
        running: 2,
        succeeded: 100,
        succeededLifetime: 100,
      });
    });

    it('returns null durableQueue when store has no stats', async () => {
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      const { result } = renderHook(() => useQueueHealthMetrics());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.durableQueue).toBeNull();
    });

    it('returns zero counts when store has zero stats', async () => {
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      useVectorStatusUIStore.setState({
        durableQueueStats: {
          failed: 0,
          nextRunnableAt: null,
          queued: 0,
          running: 0,
          succeeded: 0,
          succeededLifetime: 0,
        },
      });

      const { result } = renderHook(() => useQueueHealthMetrics());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.durableQueue).toEqual({
        failed: 0,
        nextRunnableAt: null,
        queued: 0,
        running: 0,
        succeeded: 0,
        succeededLifetime: 0,
      });
    });
  });

  describe('ephemeral queue metrics', () => {
    it('gets metrics from EmbeddingQueueProvider when available', async () => {
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue({
        metrics: {
          active: 3,
          completed: 50,
          failed: 2,
          lastError: null,
          latencyAvgMs: 150,
          latencyP50Ms: 120,
          latencyP95Ms: 300,
          progress: {},
          throughputPerMinute: 10.5,
          totalEnqueued: 55,
          windowErrorCount: 0,
        },
        queue: {} as never,
      });

      const { result } = renderHook(() => useQueueHealthMetrics());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.ephemeralQueue).toEqual({
        active: 3,
        completed: 50,
        failed: 2,
        lastError: null,
        latencyAvgMs: 150,
        latencyP50Ms: 120,
        latencyP95Ms: 300,
        progress: {},
        throughputPerMinute: 10.5,
        totalEnqueued: 55,
        windowErrorCount: 0,
      });
    });

    it('returns null ephemeralQueue when not in provider', async () => {
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      const { result } = renderHook(() => useQueueHealthMetrics());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.ephemeralQueue).toBeNull();
    });
  });

  describe('worker health', () => {
    it('returns ready state when ephemeral queue is available', async () => {
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue({
        metrics: {
          active: 0,
          completed: 0,
          failed: 0,
          lastError: null,
          latencyAvgMs: null,
          latencyP50Ms: null,
          latencyP95Ms: null,
          progress: {},
          throughputPerMinute: 0,
          totalEnqueued: 0,
          windowErrorCount: 0,
        },
        queue: {} as never,
      });

      const { result } = renderHook(() => useQueueHealthMetrics());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.workerHealth).toEqual({
        error: null,
        isReady: true,
        state: 'ready',
      });
    });

    it('returns null when ephemeral queue is not available', async () => {
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      const { result } = renderHook(() => useQueueHealthMetrics());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.workerHealth).toBeNull();
    });
  });

  describe('lastUpdated', () => {
    it('sets lastUpdated timestamp', async () => {
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue(null);

      const before = Date.now();

      const { result } = renderHook(() => useQueueHealthMetrics());

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
      vi.mocked(useEmbeddingQueueSafe).mockReturnValue({
        metrics: {
          active: 2,
          completed: 10,
          failed: 1,
          lastError: null,
          latencyAvgMs: 100,
          latencyP50Ms: 80,
          latencyP95Ms: 200,
          progress: {},
          throughputPerMinute: 5,
          totalEnqueued: 13,
          windowErrorCount: 0,
        },
        queue: {} as never,
      });

      useVectorStatusUIStore.setState({
        durableQueueStats: {
          failed: 1,
          nextRunnableAt: null,
          queued: 5,
          running: 2,
          succeeded: 100,
          succeededLifetime: 100,
        },
      });

      const { result } = renderHook(() => useQueueHealthMetrics());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.metrics.durableQueue).not.toBeNull();
      expect(result.current.metrics.ephemeralQueue).not.toBeNull();
      expect(result.current.metrics.workerHealth).not.toBeNull();

      expect(result.current.metrics.durableQueue?.queued).toBe(5);
      expect(result.current.metrics.ephemeralQueue?.active).toBe(2);
      expect(result.current.metrics.workerHealth?.isReady).toBe(true);
    });
  });
});
