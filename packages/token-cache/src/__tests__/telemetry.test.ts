/**
 * Unit tests for Token Indexer Telemetry (BST-154)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addIndexerTelemetryListener,
  createIndexerTelemetryAggregator,
  emitIndexedFile,
  emitIndexerTelemetry,
  emitIndexingBacklog,
  emitIndexingError,
  type IndexedFileTelemetryEvent,
  type IndexerTelemetryEvent,
  type IndexerTelemetryListener,
  type IndexingBacklogTelemetryEvent,
  type IndexingErrorTelemetryEvent,
} from '../telemetry';

describe('Token Indexer Telemetry', () => {
  let listeners: (() => void)[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));
  });

  afterEach(() => {
    // Clean up all listeners
    for (const unsubscribe of listeners) {
      unsubscribe();
    }
    listeners = [];
    vi.useRealTimers();
  });

  describe('emitIndexerTelemetry', () => {
    it('emits events to registered listeners', () => {
      const listener = vi.fn();
      listeners.push(addIndexerTelemetryListener(listener));

      const event: IndexerTelemetryEvent = {
        compositeKey: 'folder::/file.ts',
        elapsedMs: 50,
        event: 'indexed_file',
        filePath: '/file.ts',
        fileSize: 1024,
        folderId: 'folder',
        mode: 'accurate',
        skipped: false,
        timestamp: Date.now(),
        tokenCount: 100,
      };

      emitIndexerTelemetry(event);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(event);
    });

    it('emits to multiple listeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      listeners.push(addIndexerTelemetryListener(listener1));
      listeners.push(addIndexerTelemetryListener(listener2));

      const event: IndexerTelemetryEvent = {
        compositeKey: 'folder::/file.ts',
        errorMessage: 'Failed to read file',
        event: 'indexing_error',
        timestamp: Date.now(),
      };

      emitIndexerTelemetry(event);

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('handles listener errors gracefully', () => {
      const errorListener = vi.fn(() => {
        throw new Error('Listener error');
      });
      const goodListener = vi.fn();

      listeners.push(addIndexerTelemetryListener(errorListener));
      listeners.push(addIndexerTelemetryListener(goodListener));

      const event: IndexerTelemetryEvent = {
        batchCompleted: 3,
        batchTotal: 10,
        event: 'indexing_backlog',
        inFlight: 5,
        timestamp: Date.now(),
      };

      // Should not throw
      expect(() => emitIndexerTelemetry(event)).not.toThrow();
      // Second listener should still be called
      expect(goodListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('addIndexerTelemetryListener', () => {
    it('returns unsubscribe function', () => {
      const listener = vi.fn();
      const unsubscribe = addIndexerTelemetryListener(listener);

      // Emit an event
      emitIndexerTelemetry({
        batchCompleted: 0,
        batchTotal: 0,
        event: 'indexing_backlog',
        inFlight: 0,
        timestamp: Date.now(),
      });

      expect(listener).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscribe();

      // Emit another event
      emitIndexerTelemetry({
        batchCompleted: 0,
        batchTotal: 0,
        event: 'indexing_backlog',
        inFlight: 0,
        timestamp: Date.now(),
      });

      // Listener should not be called again
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('emitIndexedFile', () => {
    it('emits indexed_file event with correct schema', () => {
      const listener = vi.fn<IndexerTelemetryListener>();
      listeners.push(addIndexerTelemetryListener(listener));

      emitIndexedFile({
        compositeKey: 'folder::/src/index.ts',
        elapsedMs: 25,
        filePath: '/src/index.ts',
        fileSize: 2048,
        folderId: 'folder',
        mode: 'accurate',
        skipped: false,
        tokenCount: 500,
      });

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0]?.[0] as IndexedFileTelemetryEvent;
      expect(event.event).toBe('indexed_file');
      expect(event.compositeKey).toBe('folder::/src/index.ts');
      expect(event.folderId).toBe('folder');
      expect(event.filePath).toBe('/src/index.ts');
      expect(event.tokenCount).toBe(500);
      expect(event.mode).toBe('accurate');
      expect(event.fileSize).toBe(2048);
      expect(event.elapsedMs).toBe(25);
      expect(event.skipped).toBe(false);
      expect(event.timestamp).toBe(Date.now());
    });

    it('handles cache hit (skipped) correctly', () => {
      const listener = vi.fn<IndexerTelemetryListener>();
      listeners.push(addIndexerTelemetryListener(listener));

      emitIndexedFile({
        compositeKey: 'folder::/cached.ts',
        elapsedMs: 5, // Very fast - just hash check
        filePath: '/cached.ts',
        fileSize: 1024,
        folderId: 'folder',
        mode: 'accurate',
        skipped: true,
        tokenCount: 0, // Cache hits have 0 token count
      });

      const event = listener.mock.calls[0]?.[0] as IndexedFileTelemetryEvent;
      expect(event.skipped).toBe(true);
      expect(event.tokenCount).toBe(0);
    });
  });

  describe('emitIndexingError', () => {
    it('emits indexing_error event with correct schema', () => {
      const listener = vi.fn<IndexerTelemetryListener>();
      listeners.push(addIndexerTelemetryListener(listener));

      emitIndexingError({
        compositeKey: 'folder::/binary.bin',
        errorMessage: 'Binary file - cannot count tokens',
        filePath: '/binary.bin',
        folderId: 'folder',
      });

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0]?.[0] as IndexingErrorTelemetryEvent;
      expect(event.event).toBe('indexing_error');
      expect(event.compositeKey).toBe('folder::/binary.bin');
      expect(event.errorMessage).toBe('Binary file - cannot count tokens');
      expect(event.timestamp).toBe(Date.now());
    });

    it('handles minimal error (no folderId/filePath)', () => {
      const listener = vi.fn<IndexerTelemetryListener>();
      listeners.push(addIndexerTelemetryListener(listener));

      emitIndexingError({
        compositeKey: 'unknown',
        errorMessage: 'Unknown error',
      });

      const event = listener.mock.calls[0]?.[0] as IndexingErrorTelemetryEvent;
      expect(event.folderId).toBeUndefined();
      expect(event.filePath).toBeUndefined();
    });
  });

  describe('emitIndexingBacklog', () => {
    it('emits indexing_backlog event with correct schema', () => {
      const listener = vi.fn<IndexerTelemetryListener>();
      listeners.push(addIndexerTelemetryListener(listener));

      emitIndexingBacklog({
        batchCompleted: 25,
        batchTotal: 50,
        inFlight: 10,
      });

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0]?.[0] as IndexingBacklogTelemetryEvent;
      expect(event.event).toBe('indexing_backlog');
      expect(event.inFlight).toBe(10);
      expect(event.batchTotal).toBe(50);
      expect(event.batchCompleted).toBe(25);
      expect(event.timestamp).toBe(Date.now());
    });
  });

  describe('createIndexerTelemetryAggregator', () => {
    it('collects events and computes statistics', () => {
      const { snapshot, dispose } = createIndexerTelemetryAggregator(60_000);
      listeners.push(dispose);

      // Emit some indexed_file events
      emitIndexedFile({
        compositeKey: 'f1',
        elapsedMs: 10,
        filePath: '/f1.ts',
        fileSize: 1024,
        folderId: 'folder',
        mode: 'accurate',
        skipped: false,
        tokenCount: 100,
      });

      emitIndexedFile({
        compositeKey: 'f2',
        elapsedMs: 20,
        filePath: '/f2.ts',
        fileSize: 2048,
        folderId: 'folder',
        mode: 'accurate',
        skipped: false,
        tokenCount: 200,
      });

      // Emit a cache hit
      emitIndexedFile({
        compositeKey: 'f3',
        elapsedMs: 2,
        filePath: '/f3.ts',
        fileSize: 512,
        folderId: 'folder',
        mode: 'accurate',
        skipped: true,
        tokenCount: 0,
      });

      // Emit an error
      emitIndexingError({
        compositeKey: 'f4',
        errorMessage: 'Failed',
      });

      const stats = snapshot();

      expect(stats.events).toHaveLength(4);
      expect(stats.errorCount).toBe(1);
      // 2 files actually indexed (not skipped) in 60s window
      expect(stats.indexedPerMinute).toBe(2);
      // 3 total files processed (including cache hit)
      expect(stats.totalFilesPerMinute).toBe(3);
      // Total tokens from actually indexed files only
      expect(stats.totalTokensIndexed).toBe(300);
      // Cache hit rate: 1 out of 3 indexed_file events
      expect(stats.cacheHitRate).toBeCloseTo(1 / 3, 5);
      // Average latency: (10 + 20) / 2 = 15ms (excludes cache hit)
      expect(stats.averageLatencyMs).toBe(15);
    });

    it('prunes old events outside window', () => {
      const { snapshot, dispose } = createIndexerTelemetryAggregator(60_000);
      listeners.push(dispose);

      // Emit an event at t=0
      emitIndexedFile({
        compositeKey: 'old',
        elapsedMs: 10,
        filePath: '/old.ts',
        fileSize: 1024,
        folderId: 'folder',
        mode: 'accurate',
        skipped: false,
        tokenCount: 100,
      });

      // Advance time past the window
      vi.advanceTimersByTime(61_000);

      // Emit a new event
      emitIndexedFile({
        compositeKey: 'new',
        elapsedMs: 20,
        filePath: '/new.ts',
        fileSize: 2048,
        folderId: 'folder',
        mode: 'accurate',
        skipped: false,
        tokenCount: 200,
      });

      const stats = snapshot();

      // Old event should be pruned
      expect(stats.events).toHaveLength(1);
      expect(stats.totalTokensIndexed).toBe(200);
    });

    it('computes latency percentiles correctly', () => {
      const { snapshot, dispose } = createIndexerTelemetryAggregator(60_000);
      listeners.push(dispose);

      // Emit events with known latencies
      const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      for (const [i, elapsedMs] of latencies.entries()) {
        emitIndexedFile({
          compositeKey: `f${i}`,
          elapsedMs,
          filePath: `/f${i}.ts`,
          fileSize: 1024,
          folderId: 'folder',
          mode: 'accurate',
          skipped: false,
          tokenCount: 100,
        });
      }

      const stats = snapshot();

      // With floor-based percentile calculation:
      // p50: Math.floor(0.5 * 10) = 5 -> index 5 = 60ms
      // p95: Math.floor(0.95 * 10) = 9 -> index 9 = 100ms
      expect(stats.latencyP50Ms).toBe(60);
      expect(stats.latencyP95Ms).toBe(100);
    });

    it('handles zero window (no time-based pruning)', () => {
      const { snapshot, dispose } = createIndexerTelemetryAggregator(0);
      listeners.push(dispose);

      emitIndexedFile({
        compositeKey: 'f1',
        elapsedMs: 10,
        filePath: '/f1.ts',
        fileSize: 1024,
        folderId: 'folder',
        mode: 'accurate',
        skipped: false,
        tokenCount: 100,
      });

      // Advance time significantly
      vi.advanceTimersByTime(1_000_000);

      emitIndexedFile({
        compositeKey: 'f2',
        elapsedMs: 20,
        filePath: '/f2.ts',
        fileSize: 2048,
        folderId: 'folder',
        mode: 'accurate',
        skipped: false,
        tokenCount: 200,
      });

      const stats = snapshot();

      // Both events should still be present (no time pruning)
      expect(stats.events).toHaveLength(2);
    });

    it('handles empty state gracefully', () => {
      const { snapshot, dispose } = createIndexerTelemetryAggregator();
      listeners.push(dispose);

      const stats = snapshot();

      expect(stats.events).toHaveLength(0);
      expect(stats.indexedPerMinute).toBe(0);
      expect(stats.totalFilesPerMinute).toBe(0);
      expect(stats.averageLatencyMs).toBeNull();
      expect(stats.latencyP50Ms).toBeNull();
      expect(stats.latencyP95Ms).toBeNull();
      expect(stats.totalTokensIndexed).toBe(0);
      expect(stats.errorCount).toBe(0);
      expect(stats.cacheHitRate).toBeNull();
    });

    it('respects maxEvents limit', () => {
      const { snapshot, dispose } = createIndexerTelemetryAggregator(60_000, 5);
      listeners.push(dispose);

      // Emit more events than maxEvents
      for (let i = 0; i < 10; i++) {
        emitIndexedFile({
          compositeKey: `f${i}`,
          elapsedMs: 10,
          filePath: `/f${i}.ts`,
          fileSize: 1024,
          folderId: 'folder',
          mode: 'accurate',
          skipped: false,
          tokenCount: 100,
        });
      }

      const stats = snapshot();

      // Should only keep the last 5 events
      expect(stats.events).toHaveLength(5);
    });
  });
});
