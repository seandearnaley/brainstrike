import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkBudget,
  createTimer,
  PERF_BUDGETS,
  TimingCollector,
  timeOperation,
  timeOperationSync,
} from '../perf-timing';

describe('perf-timing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('PERF_BUDGETS', () => {
    it('should have all expected budget keys', () => {
      expect(PERF_BUDGETS.expandDirectory).toBe(100);
      expect(PERF_BUDGETS.collapseDirectory).toBe(50);
      expect(PERF_BUDGETS.listDirectory).toBe(200);
      expect(PERF_BUDGETS.flattenTree).toBe(50);
      expect(PERF_BUDGETS.expandBatch).toBe(500);
      expect(PERF_BUDGETS.treeSnapshot).toBe(100);
    });
  });

  describe('timeOperation', () => {
    it('should return result and timing info for fast operation', async () => {
      const operation = vi.fn().mockResolvedValue('success');

      const { result, durationMs, exceededBudget } = await timeOperation(
        'test-op',
        'expandDirectory',
        operation
      );

      expect(result).toBe('success');
      expect(durationMs).toBeGreaterThanOrEqual(0);
      expect(exceededBudget).toBe(false);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should mark exceededBudget when operation is slow', async () => {
      // Use real timers for this test
      vi.useRealTimers();

      const slowOperation = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            // Simulate slow operation with actual delay
            const start = Date.now();
            while (Date.now() - start < 60) {
              // Busy wait for 60ms
            }
            resolve('done');
          })
      );

      const { exceededBudget, durationMs } = await timeOperation(
        'slow-op',
        'collapseDirectory', // 50ms budget
        slowOperation
      );

      expect(durationMs).toBeGreaterThan(50);
      expect(exceededBudget).toBe(true);
    });

    it('should propagate errors from operation', async () => {
      const error = new Error('Operation failed');
      const failingOperation = vi.fn().mockRejectedValue(error);

      await expect(
        timeOperation('failing-op', 'expandDirectory', failingOperation)
      ).rejects.toThrow('Operation failed');
    });
  });

  describe('timeOperationSync', () => {
    it('should return result and timing info for fast sync operation', () => {
      const operation = vi.fn().mockReturnValue(42);

      const { result, durationMs, exceededBudget } = timeOperationSync(
        'sync-op',
        'flattenTree',
        operation
      );

      expect(result).toBe(42);
      expect(durationMs).toBeGreaterThanOrEqual(0);
      expect(exceededBudget).toBe(false);
    });

    it('should propagate errors from sync operation', () => {
      const error = new Error('Sync failed');
      const failingOperation = vi.fn().mockImplementation(() => {
        throw error;
      });

      expect(() => timeOperationSync('sync-fail', 'flattenTree', failingOperation)).toThrow(
        'Sync failed'
      );
    });
  });

  describe('createTimer', () => {
    it('should track elapsed time', () => {
      vi.useRealTimers();

      const timer = createTimer();

      // Busy wait for a small amount
      const start = Date.now();
      while (Date.now() - start < 5) {
        // Wait
      }

      const elapsed = timer.elapsed();
      expect(elapsed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('checkBudget', () => {
    it('should return false when within budget', () => {
      const exceeded = checkBudget('op', 50, 'expandDirectory');
      expect(exceeded).toBe(false);
    });

    it('should return true when exceeding budget', () => {
      const exceeded = checkBudget('op', 150, 'expandDirectory');
      expect(exceeded).toBe(true);
    });

    it('should return false when exactly at budget', () => {
      const exceeded = checkBudget('op', 100, 'expandDirectory');
      expect(exceeded).toBe(false);
    });
  });

  describe('TimingCollector', () => {
    it('should collect timing samples', () => {
      const collector = new TimingCollector('test-collector', 'expandDirectory');

      collector.record(10);
      collector.record(20);
      collector.record(30);

      const stats = collector.getStats();

      expect(stats.count).toBe(3);
      expect(stats.totalMs).toBe(60);
      expect(stats.minMs).toBe(10);
      expect(stats.maxMs).toBe(30);
      expect(stats.avgMs).toBe(20);
      expect(stats.exceededCount).toBe(0);
    });

    it('should track exceeded count', () => {
      const collector = new TimingCollector('test-collector', 'expandDirectory');

      collector.record(50); // Under 100ms budget
      collector.record(150); // Over budget
      collector.record(200); // Over budget

      const stats = collector.getStats();

      expect(stats.count).toBe(3);
      expect(stats.exceededCount).toBe(2);
    });

    it('should return zero stats when no samples', () => {
      const collector = new TimingCollector('empty', 'expandDirectory');

      const stats = collector.getStats();

      expect(stats.count).toBe(0);
      expect(stats.totalMs).toBe(0);
      expect(stats.minMs).toBe(0);
      expect(stats.maxMs).toBe(0);
      expect(stats.avgMs).toBe(0);
      expect(stats.exceededCount).toBe(0);
    });

    it('should reset samples', () => {
      const collector = new TimingCollector('resettable', 'expandDirectory');

      collector.record(100);
      collector.record(200);
      collector.reset();

      const stats = collector.getStats();
      expect(stats.count).toBe(0);
    });

    it('should log summary without error', () => {
      const collector = new TimingCollector('loggable', 'expandDirectory');

      collector.record(50);
      collector.record(150);

      // Should not throw
      expect(() => collector.logSummary()).not.toThrow();
    });

    it('should handle logSummary with no samples', () => {
      const collector = new TimingCollector('empty-log', 'expandDirectory');

      // Should not throw
      expect(() => collector.logSummary()).not.toThrow();
    });
  });
});
