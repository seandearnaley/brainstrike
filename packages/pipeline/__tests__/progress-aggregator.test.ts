/**
 * Tests for progress-aggregator.ts
 *
 * Covers:
 * - Progress aggregator creation and configuration
 * - Stage progress reporting (import, chunking, embedding)
 * - Error tracking and limits
 * - Phase detection and transitions
 * - Throttling behavior
 * - Utility functions (percentage, counts, formatting)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateOverallPercentage,
  createProgressAggregator,
  formatProgress,
  getTotalCounts,
  hasFailures,
  type PipelineError,
  type ProgressAggregator,
} from '../src/progress-aggregator.js';
import type { PipelineProgress } from '../src/types.js';

describe('createProgressAggregator', () => {
  let aggregator: ProgressAggregator;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('creation and defaults', () => {
    it('creates an aggregator with default configuration', () => {
      aggregator = createProgressAggregator();

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.phase).toBe('importing');
      expect(snapshot.import.total).toBe(0);
      expect(snapshot.chunking.total).toBe(0);
      expect(snapshot.embedding.total).toBe(0);
      expect(snapshot.recentErrors).toEqual([]);
    });

    it('initializes with correct start timestamp', () => {
      const now = new Date('2025-01-04T12:00:00Z');
      vi.setSystemTime(now);

      aggregator = createProgressAggregator();

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.startedAt).toBe('2025-01-04T12:00:00.000Z');
      expect(snapshot.completedAt).toBeUndefined();
    });
  });

  describe('setTotals', () => {
    it('sets file totals for import stage', () => {
      aggregator = createProgressAggregator();
      aggregator.setTotals({ files: 100 });

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.import.total).toBe(100);
    });

    it('sets chunk totals for chunking stage', () => {
      aggregator = createProgressAggregator();
      aggregator.setTotals({ chunks: 500 });

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.chunking.total).toBe(500);
    });

    it('sets embedding totals for embedding stage', () => {
      aggregator = createProgressAggregator();
      aggregator.setTotals({ embeddings: 500 });

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.embedding.total).toBe(500);
    });

    it('can update totals incrementally', () => {
      aggregator = createProgressAggregator();

      aggregator.setTotals({ files: 100 });
      aggregator.setTotals({ chunks: 300 });
      aggregator.setTotals({ embeddings: 300 });

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.import.total).toBe(100);
      expect(snapshot.chunking.total).toBe(300);
      expect(snapshot.embedding.total).toBe(300);
    });
  });

  describe('reportImportProgress', () => {
    it('updates import stage completed count', () => {
      aggregator = createProgressAggregator();
      aggregator.setTotals({ files: 10 });
      aggregator.reportImportProgress({ completed: 5 });

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.import.completed).toBe(5);
    });

    it('updates import stage inProgress count', () => {
      aggregator = createProgressAggregator();
      aggregator.reportImportProgress({ inProgress: 2 });

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.import.inProgress).toBe(2);
    });

    it('updates current item being processed', () => {
      aggregator = createProgressAggregator();
      aggregator.reportImportProgress({ currentItem: 'file.ts' });

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.import.currentItem).toBe('file.ts');
    });

    it('clears current item when completed without new item', () => {
      aggregator = createProgressAggregator();
      aggregator.reportImportProgress({ currentItem: 'file.ts' });
      aggregator.reportImportProgress({ completed: 1 });

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.import.currentItem).toBeUndefined();
    });
  });

  describe('reportChunkingProgress', () => {
    it('updates chunking stage progress', () => {
      aggregator = createProgressAggregator();
      aggregator.setTotals({ chunks: 50 });
      aggregator.reportChunkingProgress({ completed: 25, inProgress: 5 });

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.chunking.completed).toBe(25);
      expect(snapshot.chunking.inProgress).toBe(5);
    });

    it('can update chunking total dynamically', () => {
      aggregator = createProgressAggregator();
      aggregator.reportChunkingProgress({ total: 100, completed: 10 });

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.chunking.total).toBe(100);
      expect(snapshot.chunking.completed).toBe(10);
    });
  });

  describe('reportEmbeddingProgress', () => {
    it('updates embedding stage progress', () => {
      aggregator = createProgressAggregator();
      aggregator.setTotals({ embeddings: 100 });
      aggregator.reportEmbeddingProgress({ completed: 50, inProgress: 10 });

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.embedding.completed).toBe(50);
      expect(snapshot.embedding.inProgress).toBe(10);
    });
  });

  describe('phase detection', () => {
    it('starts in importing phase', () => {
      aggregator = createProgressAggregator();

      expect(aggregator.getSnapshot().phase).toBe('importing');
    });

    it('transitions to chunking when chunking progress is reported', () => {
      aggregator = createProgressAggregator();
      aggregator.reportChunkingProgress({ inProgress: 1 });

      expect(aggregator.getSnapshot().phase).toBe('chunking');
    });

    it('transitions to embedding when embedding progress is reported', () => {
      aggregator = createProgressAggregator();
      aggregator.reportEmbeddingProgress({ inProgress: 1 });

      expect(aggregator.getSnapshot().phase).toBe('embedding');
    });

    it('embedding phase takes precedence over chunking', () => {
      aggregator = createProgressAggregator();
      aggregator.reportChunkingProgress({ completed: 10 });
      aggregator.reportEmbeddingProgress({ inProgress: 1 });

      expect(aggregator.getSnapshot().phase).toBe('embedding');
    });
  });

  describe('reportError', () => {
    it('adds error to recent errors list', () => {
      const now = new Date('2025-01-04T12:00:00Z');
      vi.setSystemTime(now);

      aggregator = createProgressAggregator();
      aggregator.reportError('import', 'file.ts', 'Failed to read file');

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.recentErrors).toHaveLength(1);
      expect(snapshot.recentErrors[0]).toEqual({
        stage: 'import',
        item: 'file.ts',
        error: 'Failed to read file',
        timestamp: '2025-01-04T12:00:00.000Z',
      });
    });

    it('increments failed count for the stage', () => {
      aggregator = createProgressAggregator();
      aggregator.reportError('chunking', 'file.ts', 'Parse error');

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.chunking.failed).toBe(1);
    });

    it('limits recent errors to maxRecentErrors', () => {
      aggregator = createProgressAggregator({ maxRecentErrors: 3 });

      for (let i = 0; i < 5; i++) {
        aggregator.reportError('import', `file${i}.ts`, `Error ${i}`);
      }

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.recentErrors).toHaveLength(3);
      // Should have the most recent 3 errors
      expect(snapshot.recentErrors.map((e) => e.item)).toEqual([
        'file2.ts',
        'file3.ts',
        'file4.ts',
      ]);
    });
  });

  describe('complete', () => {
    it('sets phase to complete', () => {
      aggregator = createProgressAggregator();
      aggregator.complete();

      expect(aggregator.getSnapshot().phase).toBe('complete');
    });

    it('sets completedAt timestamp', () => {
      const now = new Date('2025-01-04T12:00:00Z');
      vi.setSystemTime(now);

      aggregator = createProgressAggregator();
      aggregator.complete();

      expect(aggregator.getSnapshot().completedAt).toBe('2025-01-04T12:00:00.000Z');
    });
  });

  describe('fail', () => {
    it('sets phase to error', () => {
      aggregator = createProgressAggregator();
      aggregator.fail('Pipeline failed');

      expect(aggregator.getSnapshot().phase).toBe('error');
    });

    it('adds final error to recent errors', () => {
      aggregator = createProgressAggregator();
      aggregator.fail('Pipeline failed');

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.recentErrors).toHaveLength(1);
      expect(snapshot.recentErrors[0]?.error).toBe('Pipeline failed');
      expect(snapshot.recentErrors[0]?.item).toBe('pipeline');
    });

    it('sets completedAt timestamp', () => {
      const now = new Date('2025-01-04T12:00:00Z');
      vi.setSystemTime(now);

      aggregator = createProgressAggregator();
      aggregator.fail('Pipeline failed');

      expect(aggregator.getSnapshot().completedAt).toBe('2025-01-04T12:00:00.000Z');
    });
  });

  describe('reset', () => {
    it('resets all progress to initial state', () => {
      aggregator = createProgressAggregator();
      aggregator.setTotals({ files: 100, chunks: 500, embeddings: 500 });
      aggregator.reportImportProgress({ completed: 50 });
      aggregator.reportChunkingProgress({ completed: 250 });
      aggregator.reportError('import', 'file.ts', 'Error');

      aggregator.reset();

      const snapshot = aggregator.getSnapshot();
      expect(snapshot.phase).toBe('importing');
      expect(snapshot.import.total).toBe(0);
      expect(snapshot.import.completed).toBe(0);
      expect(snapshot.chunking.total).toBe(0);
      expect(snapshot.chunking.completed).toBe(0);
      expect(snapshot.recentErrors).toEqual([]);
    });

    it('updates startedAt timestamp on reset', () => {
      vi.setSystemTime(new Date('2025-01-04T12:00:00Z'));
      aggregator = createProgressAggregator();

      vi.setSystemTime(new Date('2025-01-04T13:00:00Z'));
      aggregator.reset();

      expect(aggregator.getSnapshot().startedAt).toBe('2025-01-04T13:00:00.000Z');
    });
  });

  describe('throttling', () => {
    it('throttles progress callbacks', () => {
      const callback = vi.fn();
      aggregator = createProgressAggregator({
        onProgress: callback,
        throttleMs: 100,
      });

      // First update should emit
      aggregator.reportImportProgress({ completed: 1 });
      expect(callback).toHaveBeenCalledTimes(1);

      // Immediate second update should be throttled
      aggregator.reportImportProgress({ completed: 2 });
      expect(callback).toHaveBeenCalledTimes(1);

      // After throttle period, should emit
      vi.advanceTimersByTime(100);
      aggregator.reportImportProgress({ completed: 3 });
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('flush bypasses throttle', () => {
      const callback = vi.fn();
      aggregator = createProgressAggregator({
        onProgress: callback,
        throttleMs: 100,
      });

      aggregator.reportImportProgress({ completed: 1 });
      expect(callback).toHaveBeenCalledTimes(1);

      aggregator.reportImportProgress({ completed: 2 });
      expect(callback).toHaveBeenCalledTimes(1);

      aggregator.flush();
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('complete forces emit regardless of throttle', () => {
      const callback = vi.fn();
      aggregator = createProgressAggregator({
        onProgress: callback,
        throttleMs: 100,
      });

      aggregator.reportImportProgress({ completed: 1 });
      expect(callback).toHaveBeenCalledTimes(1);

      aggregator.complete();
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSnapshot immutability', () => {
    it('returns independent snapshots', () => {
      aggregator = createProgressAggregator();
      aggregator.setTotals({ files: 10 });

      const snapshot1 = aggregator.getSnapshot();
      aggregator.reportImportProgress({ completed: 5 });
      const snapshot2 = aggregator.getSnapshot();

      expect(snapshot1.import.completed).toBe(0);
      expect(snapshot2.import.completed).toBe(5);
    });

    it('snapshot mutations do not affect aggregator state', () => {
      aggregator = createProgressAggregator();
      aggregator.setTotals({ files: 10 });

      const snapshot = aggregator.getSnapshot();
      snapshot.import.completed = 999;
      (snapshot.recentErrors as PipelineError[]).push({
        stage: 'import',
        item: 'fake',
        error: 'fake',
        timestamp: 'fake',
      });

      const freshSnapshot = aggregator.getSnapshot();
      expect(freshSnapshot.import.completed).toBe(0);
      expect(freshSnapshot.recentErrors).toHaveLength(0);
    });
  });
});

describe('utility functions', () => {
  describe('calculateOverallPercentage', () => {
    it('returns 0 when no totals are set', () => {
      const progress: PipelineProgress = {
        phase: 'importing',
        import: { total: 0, completed: 0, inProgress: 0, failed: 0 },
        chunking: { total: 0, completed: 0, inProgress: 0, failed: 0 },
        embedding: { total: 0, completed: 0, inProgress: 0, failed: 0 },
        startedAt: '',
        recentErrors: [],
      };

      expect(calculateOverallPercentage(progress)).toBe(0);
    });

    it('calculates weighted percentage correctly', () => {
      const progress: PipelineProgress = {
        phase: 'embedding',
        import: { total: 100, completed: 100, inProgress: 0, failed: 0 }, // 100% * 0.2 = 20
        chunking: { total: 200, completed: 200, inProgress: 0, failed: 0 }, // 100% * 0.3 = 30
        embedding: { total: 200, completed: 100, inProgress: 0, failed: 0 }, // 50% * 0.5 = 25
        startedAt: '',
        recentErrors: [],
      };

      // 20 + 30 + 25 = 75
      expect(calculateOverallPercentage(progress)).toBe(75);
    });

    it('handles partial completion', () => {
      const progress: PipelineProgress = {
        phase: 'chunking',
        import: { total: 100, completed: 50, inProgress: 0, failed: 0 }, // 50% * 0.2 = 10
        chunking: { total: 200, completed: 0, inProgress: 0, failed: 0 }, // 0% * 0.3 = 0
        embedding: { total: 0, completed: 0, inProgress: 0, failed: 0 }, // 0% * 0.5 = 0
        startedAt: '',
        recentErrors: [],
      };

      expect(calculateOverallPercentage(progress)).toBe(10);
    });
  });

  describe('hasFailures', () => {
    it('returns false when no failures', () => {
      const progress: PipelineProgress = {
        phase: 'complete',
        import: { total: 100, completed: 100, inProgress: 0, failed: 0 },
        chunking: { total: 200, completed: 200, inProgress: 0, failed: 0 },
        embedding: { total: 200, completed: 200, inProgress: 0, failed: 0 },
        startedAt: '',
        recentErrors: [],
      };

      expect(hasFailures(progress)).toBe(false);
    });

    it('returns true when import has failures', () => {
      const progress: PipelineProgress = {
        phase: 'complete',
        import: { total: 100, completed: 99, inProgress: 0, failed: 1 },
        chunking: { total: 200, completed: 200, inProgress: 0, failed: 0 },
        embedding: { total: 200, completed: 200, inProgress: 0, failed: 0 },
        startedAt: '',
        recentErrors: [],
      };

      expect(hasFailures(progress)).toBe(true);
    });

    it('returns true when chunking has failures', () => {
      const progress: PipelineProgress = {
        phase: 'complete',
        import: { total: 100, completed: 100, inProgress: 0, failed: 0 },
        chunking: { total: 200, completed: 195, inProgress: 0, failed: 5 },
        embedding: { total: 200, completed: 200, inProgress: 0, failed: 0 },
        startedAt: '',
        recentErrors: [],
      };

      expect(hasFailures(progress)).toBe(true);
    });

    it('returns true when embedding has failures', () => {
      const progress: PipelineProgress = {
        phase: 'complete',
        import: { total: 100, completed: 100, inProgress: 0, failed: 0 },
        chunking: { total: 200, completed: 200, inProgress: 0, failed: 0 },
        embedding: { total: 200, completed: 190, inProgress: 0, failed: 10 },
        startedAt: '',
        recentErrors: [],
      };

      expect(hasFailures(progress)).toBe(true);
    });
  });

  describe('getTotalCounts', () => {
    it('aggregates counts across all stages', () => {
      const progress: PipelineProgress = {
        phase: 'embedding',
        import: { total: 100, completed: 100, inProgress: 0, failed: 5 },
        chunking: { total: 200, completed: 150, inProgress: 10, failed: 3 },
        embedding: { total: 200, completed: 50, inProgress: 20, failed: 2 },
        startedAt: '',
        recentErrors: [],
      };

      const counts = getTotalCounts(progress);

      expect(counts.total).toBe(500); // 100 + 200 + 200
      expect(counts.completed).toBe(300); // 100 + 150 + 50
      expect(counts.failed).toBe(10); // 5 + 3 + 2
      expect(counts.inProgress).toBe(30); // 0 + 10 + 20
    });
  });

  describe('formatProgress', () => {
    it('formats progress with all stages', () => {
      const progress: PipelineProgress = {
        phase: 'embedding',
        import: { total: 100, completed: 100, inProgress: 0, failed: 0 },
        chunking: { total: 200, completed: 200, inProgress: 0, failed: 0 },
        embedding: { total: 200, completed: 100, inProgress: 0, failed: 0 },
        startedAt: '',
        recentErrors: [],
      };

      const formatted = formatProgress(progress);

      expect(formatted).toContain('Phase: embedding');
      expect(formatted).toContain('Import: 100/100');
      expect(formatted).toContain('Chunking: 200/200');
      expect(formatted).toContain('Embedding: 100/200');
      expect(formatted).toContain('75.0%');
    });

    it('omits stages with zero total', () => {
      const progress: PipelineProgress = {
        phase: 'importing',
        import: { total: 10, completed: 5, inProgress: 0, failed: 0 },
        chunking: { total: 0, completed: 0, inProgress: 0, failed: 0 },
        embedding: { total: 0, completed: 0, inProgress: 0, failed: 0 },
        startedAt: '',
        recentErrors: [],
      };

      const formatted = formatProgress(progress);

      expect(formatted).toContain('Import: 5/10');
      expect(formatted).not.toContain('Chunking');
      expect(formatted).not.toContain('Embedding');
    });
  });
});

describe('integration scenarios', () => {
  it('simulates a complete pipeline run', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-04T12:00:00Z'));

    const progressHistory: PipelineProgress[] = [];
    const aggregator = createProgressAggregator({
      onProgress: (p) => progressHistory.push(p),
      throttleMs: 0, // No throttle for testing
    });

    // Set initial totals
    aggregator.setTotals({ files: 3 });

    // Import phase
    aggregator.reportImportProgress({ inProgress: 1, currentItem: 'file1.ts' });
    aggregator.reportImportProgress({ completed: 1, inProgress: 1, currentItem: 'file2.ts' });
    aggregator.reportImportProgress({ completed: 2, inProgress: 1, currentItem: 'file3.ts' });
    aggregator.reportImportProgress({ completed: 3 });

    // Chunking phase (discovered 10 chunks)
    aggregator.setTotals({ chunks: 10 });
    aggregator.reportChunkingProgress({ inProgress: 1 });
    for (let i = 1; i <= 10; i++) {
      aggregator.reportChunkingProgress({ completed: i, inProgress: i < 10 ? 1 : 0 });
    }

    // Embedding phase (10 embeddings)
    aggregator.setTotals({ embeddings: 10 });
    aggregator.reportEmbeddingProgress({ inProgress: 1 });
    for (let i = 1; i <= 10; i++) {
      aggregator.reportEmbeddingProgress({ completed: i, inProgress: i < 10 ? 1 : 0 });
    }

    // Complete
    aggregator.complete();

    const finalSnapshot = aggregator.getSnapshot();
    expect(finalSnapshot.phase).toBe('complete');
    expect(finalSnapshot.import.completed).toBe(3);
    expect(finalSnapshot.chunking.completed).toBe(10);
    expect(finalSnapshot.embedding.completed).toBe(10);
    expect(finalSnapshot.completedAt).toBeDefined();
    expect(calculateOverallPercentage(finalSnapshot)).toBe(100);

    vi.useRealTimers();
  });

  it('handles errors during processing', () => {
    const aggregator = createProgressAggregator();

    aggregator.setTotals({ files: 5 });
    aggregator.reportImportProgress({ completed: 3 });
    aggregator.reportError('import', 'bad-file.ts', 'Permission denied');
    aggregator.reportImportProgress({ completed: 4 });
    aggregator.reportError('import', 'corrupt-file.ts', 'Invalid encoding');

    const snapshot = aggregator.getSnapshot();
    expect(snapshot.import.failed).toBe(2);
    expect(snapshot.recentErrors).toHaveLength(2);
    expect(hasFailures(snapshot)).toBe(true);
  });

  it('maintains accuracy under retries', () => {
    const aggregator = createProgressAggregator();

    // Simulate processing with a retry
    aggregator.setTotals({ files: 2 });

    // First file succeeds
    aggregator.reportImportProgress({ completed: 1, inProgress: 1 });

    // Second file fails
    aggregator.reportError('import', 'flaky-file.ts', 'Network timeout');

    // Retry second file - completed count stays at 1 until success
    aggregator.reportImportProgress({ completed: 1, inProgress: 1, currentItem: 'flaky-file.ts' });

    // Retry succeeds
    aggregator.reportImportProgress({ completed: 2 });

    const snapshot = aggregator.getSnapshot();
    expect(snapshot.import.completed).toBe(2);
    expect(snapshot.import.failed).toBe(1); // Error was logged
    expect(snapshot.recentErrors).toHaveLength(1);
  });
});
