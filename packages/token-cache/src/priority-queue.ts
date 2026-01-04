/**
 * Priority Queue for Token Indexing (BST-151)
 *
 * Manages prioritized batches of files to be indexed.
 * Lower priority values are processed first (VISIBLE=0 before SELECTED=1).
 *
 * Uses simple array-based queue with insertion sort for simplicity
 * (heap not needed - batch count is typically small <10).
 */

import type { IndexingPriority } from './types';

/**
 * A batch of files waiting to be indexed
 */
export type PrioritizedBatch<TRequest> = {
  /** Unique identifier for this batch */
  batchId: string;
  /** Priority level (lower = higher priority) */
  priority: IndexingPriority;
  /** Requests in this batch */
  requests: TRequest[];
  /** Whether this batch has been cancelled */
  cancelled: boolean;
  /** Timestamp when batch was submitted (for stable sort) */
  submittedAt: number;
};

/**
 * Priority queue for indexing batches.
 *
 * Batches are sorted by:
 * 1. Priority (ascending - lower values first)
 * 2. Submission time (ascending - FIFO within same priority)
 *
 * @example
 * ```typescript
 * const queue = new IndexerPriorityQueue<IndexerRequest>();
 *
 * // Enqueue batches with different priorities
 * queue.enqueue({
 *   batchId: 'visible-1',
 *   priority: IndexingPriority.VISIBLE,
 *   requests: [...],
 *   cancelled: false,
 *   submittedAt: Date.now(),
 * });
 *
 * // Dequeue processes highest priority first
 * const next = queue.dequeueNext(); // Returns visible batch
 * ```
 */
export class IndexerPriorityQueue<TRequest> {
  private batches: PrioritizedBatch<TRequest>[] = [];

  /**
   * Current number of batches in queue (including cancelled)
   */
  get size(): number {
    return this.batches.length;
  }

  /**
   * Number of non-cancelled batches
   */
  get activeSize(): number {
    return this.batches.filter((b) => !b.cancelled).length;
  }

  /**
   * Enqueue a batch, maintaining priority order.
   *
   * Insertion is O(n) but n is typically small (< 10 batches).
   */
  enqueue(batch: PrioritizedBatch<TRequest>): void {
    // Find insertion point maintaining stable sort
    const insertIdx = this.batches.findIndex(
      (b) =>
        b.priority > batch.priority ||
        (b.priority === batch.priority && b.submittedAt > batch.submittedAt)
    );

    if (insertIdx === -1) {
      this.batches.push(batch);
    } else {
      this.batches.splice(insertIdx, 0, batch);
    }
  }

  /**
   * Dequeue the next non-cancelled batch.
   *
   * Skips and removes cancelled batches automatically.
   *
   * @returns Next batch to process, or undefined if queue is empty
   */
  dequeueNext(): PrioritizedBatch<TRequest> | undefined {
    while (this.batches.length > 0) {
      const batch = this.batches.shift();
      if (batch && !batch.cancelled) {
        return batch;
      }
      // Cancelled batch - discard and continue
    }
    return;
  }

  /**
   * Peek at the next batch without removing it.
   *
   * @returns Next non-cancelled batch, or undefined
   */
  peek(): PrioritizedBatch<TRequest> | undefined {
    for (const batch of this.batches) {
      if (!batch.cancelled) {
        return batch;
      }
    }
    return;
  }

  /**
   * Cancel a specific batch by ID.
   *
   * The batch remains in queue but will be skipped during dequeue.
   *
   * @returns true if batch was found and cancelled, false if not found
   */
  cancelBatch(batchId: string): boolean {
    const batch = this.batches.find((b) => b.batchId === batchId);
    if (batch) {
      batch.cancelled = true;
      return true;
    }
    return false;
  }

  /**
   * Cancel all batches and clear the queue.
   */
  cancelAll(): void {
    for (const batch of this.batches) {
      batch.cancelled = true;
    }
    this.batches = [];
  }

  /**
   * Check if a batch with given ID exists (cancelled or not).
   */
  hasBatch(batchId: string): boolean {
    return this.batches.some((b) => b.batchId === batchId);
  }

  /**
   * Get batch by ID.
   */
  getBatch(batchId: string): PrioritizedBatch<TRequest> | undefined {
    return this.batches.find((b) => b.batchId === batchId);
  }

  /**
   * Get all batches (for diagnostics).
   */
  getAllBatches(): readonly PrioritizedBatch<TRequest>[] {
    return this.batches;
  }

  /**
   * Remove completed/cancelled batches older than TTL.
   *
   * Call periodically to prevent memory growth.
   *
   * @param ttlMs Time-to-live in milliseconds (default: 60 seconds)
   */
  cleanup(ttlMs = 60_000): number {
    const now = Date.now();
    const before = this.batches.length;

    this.batches = this.batches.filter((b) => !b.cancelled || now - b.submittedAt < ttlMs);

    return before - this.batches.length;
  }
}
