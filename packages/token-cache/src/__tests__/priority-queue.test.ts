/**
 * Tests for IndexerPriorityQueue (BST-151)
 */

import { describe, expect, it } from 'vitest';
import { IndexerPriorityQueue, type PrioritizedBatch } from '../priority-queue';
import { IndexingPriority } from '../types';

type TestRequest = { id: string; path: string };

function createBatch(
  batchId: string,
  priority: IndexingPriority,
  submittedAt = Date.now()
): PrioritizedBatch<TestRequest> {
  return {
    batchId,
    priority,
    requests: [{ id: `${batchId}-req`, path: `/path/${batchId}` }],
    cancelled: false,
    submittedAt,
  };
}

describe('IndexerPriorityQueue', () => {
  describe('enqueue', () => {
    it('should add batches to the queue', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();
      const batch = createBatch('batch-1', IndexingPriority.SELECTED);

      queue.enqueue(batch);

      expect(queue.size).toBe(1);
      expect(queue.hasBatch('batch-1')).toBe(true);
    });

    it('should maintain priority order (lower priority value = higher priority)', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      // Enqueue in reverse order
      queue.enqueue(createBatch('background', IndexingPriority.BACKGROUND, 1));
      queue.enqueue(createBatch('selected', IndexingPriority.SELECTED, 2));
      queue.enqueue(createBatch('visible', IndexingPriority.VISIBLE, 3));

      // Should dequeue in priority order: VISIBLE first
      expect(queue.dequeueNext()?.batchId).toBe('visible');
      expect(queue.dequeueNext()?.batchId).toBe('selected');
      expect(queue.dequeueNext()?.batchId).toBe('background');
    });

    it('should maintain FIFO order within same priority (stable sort)', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();
      const baseTime = Date.now();

      queue.enqueue(createBatch('selected-1', IndexingPriority.SELECTED, baseTime));
      queue.enqueue(createBatch('selected-2', IndexingPriority.SELECTED, baseTime + 10));
      queue.enqueue(createBatch('selected-3', IndexingPriority.SELECTED, baseTime + 20));

      expect(queue.dequeueNext()?.batchId).toBe('selected-1');
      expect(queue.dequeueNext()?.batchId).toBe('selected-2');
      expect(queue.dequeueNext()?.batchId).toBe('selected-3');
    });

    it('should insert high-priority batches before lower-priority ones', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();
      const baseTime = Date.now();

      // Enqueue background first
      queue.enqueue(createBatch('background-1', IndexingPriority.BACKGROUND, baseTime));

      // Then enqueue visible (should jump to front)
      queue.enqueue(createBatch('visible-1', IndexingPriority.VISIBLE, baseTime + 10));

      expect(queue.peek()?.batchId).toBe('visible-1');
    });
  });

  describe('dequeueNext', () => {
    it('should return undefined for empty queue', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();
      expect(queue.dequeueNext()).toBeUndefined();
    });

    it('should skip cancelled batches', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      const batch1 = createBatch('batch-1', IndexingPriority.VISIBLE, 1);
      const batch2 = createBatch('batch-2', IndexingPriority.VISIBLE, 2);

      queue.enqueue(batch1);
      queue.enqueue(batch2);

      // Cancel first batch
      queue.cancelBatch('batch-1');

      // Should skip batch-1 and return batch-2
      expect(queue.dequeueNext()?.batchId).toBe('batch-2');
    });

    it('should remove batches from queue when dequeued', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      queue.enqueue(createBatch('batch-1', IndexingPriority.SELECTED));

      expect(queue.size).toBe(1);
      queue.dequeueNext();
      expect(queue.size).toBe(0);
    });
  });

  describe('peek', () => {
    it('should return undefined for empty queue', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();
      expect(queue.peek()).toBeUndefined();
    });

    it('should return next batch without removing it', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      queue.enqueue(createBatch('batch-1', IndexingPriority.SELECTED));

      expect(queue.peek()?.batchId).toBe('batch-1');
      expect(queue.size).toBe(1); // Still in queue
    });

    it('should skip cancelled batches', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      queue.enqueue(createBatch('cancelled', IndexingPriority.VISIBLE, 1));
      queue.enqueue(createBatch('active', IndexingPriority.VISIBLE, 2));

      queue.cancelBatch('cancelled');

      expect(queue.peek()?.batchId).toBe('active');
    });
  });

  describe('cancelBatch', () => {
    it('should return true when batch is found and cancelled', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      queue.enqueue(createBatch('batch-1', IndexingPriority.SELECTED));

      expect(queue.cancelBatch('batch-1')).toBe(true);
    });

    it('should return false when batch is not found', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      expect(queue.cancelBatch('non-existent')).toBe(false);
    });

    it('should mark batch as cancelled', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      queue.enqueue(createBatch('batch-1', IndexingPriority.SELECTED));
      queue.cancelBatch('batch-1');

      const batch = queue.getBatch('batch-1');
      expect(batch?.cancelled).toBe(true);
    });
  });

  describe('cancelAll', () => {
    it('should cancel all batches and clear the queue', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      queue.enqueue(createBatch('batch-1', IndexingPriority.VISIBLE));
      queue.enqueue(createBatch('batch-2', IndexingPriority.SELECTED));
      queue.enqueue(createBatch('batch-3', IndexingPriority.BACKGROUND));

      queue.cancelAll();

      expect(queue.size).toBe(0);
      expect(queue.dequeueNext()).toBeUndefined();
    });
  });

  describe('activeSize', () => {
    it('should count only non-cancelled batches', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      queue.enqueue(createBatch('batch-1', IndexingPriority.VISIBLE));
      queue.enqueue(createBatch('batch-2', IndexingPriority.SELECTED));

      expect(queue.activeSize).toBe(2);

      queue.cancelBatch('batch-1');

      expect(queue.activeSize).toBe(1);
      expect(queue.size).toBe(2); // Total size still 2
    });
  });

  describe('getBatch', () => {
    it('should return batch by ID', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      queue.enqueue(createBatch('batch-1', IndexingPriority.SELECTED));

      const batch = queue.getBatch('batch-1');
      expect(batch?.batchId).toBe('batch-1');
      expect(batch?.priority).toBe(IndexingPriority.SELECTED);
    });

    it('should return undefined for non-existent batch', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      expect(queue.getBatch('non-existent')).toBeUndefined();
    });
  });

  describe('getAllBatches', () => {
    it('should return readonly array of all batches', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      queue.enqueue(createBatch('batch-1', IndexingPriority.VISIBLE));
      queue.enqueue(createBatch('batch-2', IndexingPriority.SELECTED));

      const batches = queue.getAllBatches();

      expect(batches).toHaveLength(2);
      expect(batches[0]?.batchId).toBe('batch-1');
      expect(batches[1]?.batchId).toBe('batch-2');
    });
  });

  describe('cleanup', () => {
    it('should remove cancelled batches older than TTL', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();
      const oldTime = Date.now() - 120_000; // 2 minutes ago

      queue.enqueue(createBatch('old-cancelled', IndexingPriority.SELECTED, oldTime));
      queue.cancelBatch('old-cancelled');

      queue.enqueue(createBatch('active', IndexingPriority.SELECTED));

      const removed = queue.cleanup(60_000); // 1 minute TTL

      expect(removed).toBe(1);
      expect(queue.size).toBe(1);
      expect(queue.hasBatch('active')).toBe(true);
      expect(queue.hasBatch('old-cancelled')).toBe(false);
    });

    it('should not remove active batches', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();
      const oldTime = Date.now() - 120_000;

      queue.enqueue(createBatch('old-active', IndexingPriority.SELECTED, oldTime));

      const removed = queue.cleanup(60_000);

      expect(removed).toBe(0);
      expect(queue.hasBatch('old-active')).toBe(true);
    });

    it('should return count of removed batches', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();
      const oldTime = Date.now() - 120_000;

      queue.enqueue(createBatch('cancelled-1', IndexingPriority.SELECTED, oldTime));
      queue.enqueue(createBatch('cancelled-2', IndexingPriority.SELECTED, oldTime));
      queue.cancelBatch('cancelled-1');
      queue.cancelBatch('cancelled-2');

      const removed = queue.cleanup(60_000);

      expect(removed).toBe(2);
    });
  });

  describe('priority ordering scenarios', () => {
    it('should process visible files first during scroll', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();
      const baseTime = Date.now();

      // User selects many files, then scrolls to see a few
      queue.enqueue(createBatch('selected-1', IndexingPriority.SELECTED, baseTime));
      queue.enqueue(createBatch('selected-2', IndexingPriority.SELECTED, baseTime + 1));
      queue.enqueue(createBatch('selected-3', IndexingPriority.SELECTED, baseTime + 2));

      // User scrolls - these should jump to front
      queue.enqueue(createBatch('visible-1', IndexingPriority.VISIBLE, baseTime + 10));
      queue.enqueue(createBatch('visible-2', IndexingPriority.VISIBLE, baseTime + 11));

      // Visible batches should be processed first
      expect(queue.dequeueNext()?.batchId).toBe('visible-1');
      expect(queue.dequeueNext()?.batchId).toBe('visible-2');
      expect(queue.dequeueNext()?.batchId).toBe('selected-1');
    });

    it('should handle mixed priority insertions correctly', () => {
      const queue = new IndexerPriorityQueue<TestRequest>();

      // Random insertion order
      queue.enqueue(createBatch('bg-1', IndexingPriority.BACKGROUND, 1));
      queue.enqueue(createBatch('vis-1', IndexingPriority.VISIBLE, 2));
      queue.enqueue(createBatch('sel-1', IndexingPriority.SELECTED, 3));
      queue.enqueue(createBatch('vis-2', IndexingPriority.VISIBLE, 4));
      queue.enqueue(createBatch('bg-2', IndexingPriority.BACKGROUND, 5));

      // Should come out in priority order, FIFO within same priority
      expect(queue.dequeueNext()?.batchId).toBe('vis-1');
      expect(queue.dequeueNext()?.batchId).toBe('vis-2');
      expect(queue.dequeueNext()?.batchId).toBe('sel-1');
      expect(queue.dequeueNext()?.batchId).toBe('bg-1');
      expect(queue.dequeueNext()?.batchId).toBe('bg-2');
    });
  });
});
