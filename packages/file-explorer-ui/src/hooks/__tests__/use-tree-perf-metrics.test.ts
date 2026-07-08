/**
 * Tests for useTreePerfMetrics hook
 *
 * Part of BST-145: Performance budgets + instrumentation hooks
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the perf-timing module
vi.mock('@brainstrike/utils/perf-timing', () => ({
  checkBudget: vi.fn((_name, durationMs, _key) => durationMs > 50),
  createTimer: vi.fn(() => ({
    elapsed: vi.fn(() => 10), // Default 10ms
  })),
}));

// Store original env values
const originalEnv = { ...import.meta.env };

describe('useTreePerfMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original env
    Object.assign(import.meta.env, originalEnv);
  });

  describe('isPerfMetricsEnabled', () => {
    it('returns true when DEV and VITE_DEV_PERF_METRICS are set', async () => {
      // Set up env before importing module
      import.meta.env.DEV = true;
      import.meta.env['VITE_DEV_PERF_METRICS'] = 'true';

      const { isPerfMetricsEnabled } = await import('../use-tree-perf-metrics');
      expect(isPerfMetricsEnabled()).toBe(true);
    });

    it('returns false when not in DEV mode', async () => {
      import.meta.env.DEV = false;
      import.meta.env['VITE_DEV_PERF_METRICS'] = 'true';

      const { isPerfMetricsEnabled } = await import('../use-tree-perf-metrics');
      expect(isPerfMetricsEnabled()).toBe(false);
    });

    it('returns false when VITE_DEV_PERF_METRICS is not set', async () => {
      import.meta.env.DEV = true;
      import.meta.env['VITE_DEV_PERF_METRICS'] = undefined;

      const { isPerfMetricsEnabled } = await import('../use-tree-perf-metrics');
      expect(isPerfMetricsEnabled()).toBe(false);
    });
  });

  describe('measureFlatten (enabled)', () => {
    beforeEach(() => {
      import.meta.env.DEV = true;
      import.meta.env['VITE_DEV_PERF_METRICS'] = 'true';
    });

    it('executes operation and returns result', async () => {
      const { useTreePerfMetrics } = await import('../use-tree-perf-metrics');
      const { result } = renderHook(() => useTreePerfMetrics());

      const flattenResult = result.current.measureFlatten('test', 100, () => ['a', 'b', 'c']);

      expect(flattenResult).toEqual(['a', 'b', 'c']);
    });

    it('records metric when enabled', async () => {
      const { useTreePerfMetrics } = await import('../use-tree-perf-metrics');
      const { result } = renderHook(() => useTreePerfMetrics());

      act(() => {
        result.current.measureFlatten('flattenTree', 100, () => []);
      });

      // Wait for state update
      await vi.waitFor(() => {
        expect(result.current.metrics.length).toBe(1);
      });

      expect(result.current.metrics[0]).toMatchObject({
        budgetKey: 'flattenTree',
        metadata: { nodeCount: 100 },
        name: 'flattenTree',
      });
    });
  });

  describe('measureFlatten (disabled)', () => {
    beforeEach(() => {
      import.meta.env.DEV = false;
      import.meta.env['VITE_DEV_PERF_METRICS'] = undefined;
    });

    it('executes operation without recording when disabled', async () => {
      const { useTreePerfMetrics } = await import('../use-tree-perf-metrics');
      const { result } = renderHook(() => useTreePerfMetrics());

      const flattenResult = result.current.measureFlatten('test', 100, () => ['a', 'b', 'c']);

      expect(flattenResult).toEqual(['a', 'b', 'c']);
      expect(result.current.metrics.length).toBe(0);
    });
  });

  describe('measureRender (enabled)', () => {
    beforeEach(() => {
      import.meta.env.DEV = true;
      import.meta.env['VITE_DEV_PERF_METRICS'] = 'true';
    });

    it('executes operation', async () => {
      const { useTreePerfMetrics } = await import('../use-tree-perf-metrics');
      const { result } = renderHook(() => useTreePerfMetrics());
      const mockFn = vi.fn();

      act(() => {
        result.current.measureRender('render', 50, mockFn);
      });

      expect(mockFn).toHaveBeenCalledOnce();
    });

    it('records metric when enabled', async () => {
      const { useTreePerfMetrics } = await import('../use-tree-perf-metrics');
      const { result } = renderHook(() => useTreePerfMetrics());

      act(() => {
        result.current.measureRender('render', 50, () => {});
      });

      await vi.waitFor(() => {
        expect(result.current.metrics.length).toBe(1);
      });

      expect(result.current.metrics[0]).toMatchObject({
        budgetKey: 'treeSnapshot',
        metadata: { rowCount: 50 },
        name: 'render',
      });
    });
  });

  describe('getSummary (enabled)', () => {
    beforeEach(() => {
      import.meta.env.DEV = true;
      import.meta.env['VITE_DEV_PERF_METRICS'] = 'true';
    });

    it('returns aggregated summary', async () => {
      const { useTreePerfMetrics } = await import('../use-tree-perf-metrics');
      const { result } = renderHook(() => useTreePerfMetrics());

      // Record some metrics
      act(() => {
        result.current.measureFlatten('flatten1', 100, () => []);
        result.current.measureFlatten('flatten2', 200, () => []);
        result.current.measureRender('render1', 50, () => {});
      });

      await vi.waitFor(() => {
        expect(result.current.metrics.length).toBe(3);
      });

      const summary = result.current.getSummary();

      expect(summary.totalRenders).toBe(1);
      expect(summary.lastMetrics.length).toBe(3);
    });
  });

  describe('clearMetrics (enabled)', () => {
    beforeEach(() => {
      import.meta.env.DEV = true;
      import.meta.env['VITE_DEV_PERF_METRICS'] = 'true';
    });

    it('clears all metrics', async () => {
      const { useTreePerfMetrics } = await import('../use-tree-perf-metrics');
      const { result } = renderHook(() => useTreePerfMetrics());

      act(() => {
        result.current.measureFlatten('test', 100, () => []);
      });

      await vi.waitFor(() => {
        expect(result.current.metrics.length).toBe(1);
      });

      act(() => {
        result.current.clearMetrics();
      });

      expect(result.current.metrics.length).toBe(0);
      expect(result.current.getSummary().totalRenders).toBe(0);
    });
  });
});
