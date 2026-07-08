import { addQueueTelemetryListener, type QueueTelemetryEvent } from '@brainstrike/queue';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { wasmLoader } from '../src/wasm-loader.js';

/**
 * Tests for JobQueue telemetry integration (BST-163).
 *
 * Verifies that JobQueue emits consistent telemetry events
 * using the unified queue telemetry schema defined in ADR-0002.
 */
describe('JobQueue telemetry (BST-163)', () => {
  let db: PGlite;
  let events: QueueTelemetryEvent[];
  let unsubscribe: () => void;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://job-queue-telemetry-tests');
    await migrate(db);
    events = [];
    unsubscribe = addQueueTelemetryListener((event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    unsubscribe();
  });

  describe('adapter identifier', () => {
    it('uses "job-queue" adapter for all events', async () => {
      const queue = new JobQueue(db);
      await queue.enqueue({
        jobType: 'embed_chunk',
        payload: { chunkId: 'c1' },
        queue: 'embeddings',
      });

      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.adapter === 'job-queue')).toBe(true);
    });
  });

  describe('enqueue event', () => {
    it('emits enqueue event when job is created', async () => {
      const queue = new JobQueue(db);
      const job = await queue.enqueue({
        dedupeKey: 'test-key',
        jobType: 'embed_chunk',
        payload: { chunkId: 'c1' },
        queue: 'embeddings',
      });

      const enqueueEvent = events.find((e) => e.event === 'enqueue');
      expect(enqueueEvent).toBeDefined();
      expect(enqueueEvent?.taskId).toBe(job.id);
      expect(enqueueEvent?.metadata).toMatchObject({
        dedupeKey: 'test-key',
        jobType: 'embed_chunk',
        queue: 'embeddings',
      });
    });

    it('does not emit enqueue event for deduplicated job', async () => {
      const queue = new JobQueue(db);

      // First enqueue
      await queue.enqueue({
        dedupeKey: 'same-key',
        jobType: 'embed_chunk',
        payload: { chunkId: 'c1' },
        queue: 'embeddings',
      });

      const firstEnqueueCount = events.filter((e) => e.event === 'enqueue').length;
      expect(firstEnqueueCount).toBe(1);

      // Second enqueue with same dedupe key
      await queue.enqueue({
        dedupeKey: 'same-key',
        jobType: 'embed_chunk',
        payload: { chunkId: 'c1' },
        queue: 'embeddings',
      });

      const secondEnqueueCount = events.filter((e) => e.event === 'enqueue').length;
      expect(secondEnqueueCount).toBe(1); // No new enqueue event
    });
  });

  describe('start event', () => {
    it('emits start event when job is claimed', async () => {
      const queue = new JobQueue(db);
      const job = await queue.enqueue({
        jobType: 'embed_chunk',
        payload: { chunkId: 'c1' },
        queue: 'embeddings',
      });

      events = []; // Clear enqueue events

      await queue.claim({ leaseMs: 5000, queue: 'embeddings', workerId: 'worker-1' });

      const startEvent = events.find((e) => e.event === 'start');
      expect(startEvent).toBeDefined();
      expect(startEvent?.taskId).toBe(job.id);
      expect(startEvent?.metadata).toMatchObject({
        attempt: 1,
        jobType: 'embed_chunk',
        leaseMs: 5000,
        queue: 'embeddings',
        workerId: 'worker-1',
      });
    });

    it('emits start event for each job in claimMany', async () => {
      const queue = new JobQueue(db);
      await queue.enqueue({
        jobType: 'embed_chunk',
        payload: { chunkId: 'c1' },
        queue: 'embeddings',
      });
      await queue.enqueue({
        jobType: 'embed_chunk',
        payload: { chunkId: 'c2' },
        queue: 'embeddings',
      });

      events = []; // Clear enqueue events

      const claimed = await queue.claimMany({ leaseMs: 5000, limit: 2, queue: 'embeddings' });

      const startEvents = events.filter((e) => e.event === 'start');
      expect(startEvents.length).toBe(claimed.length);
      expect(startEvents.length).toBe(2);
    });
  });

  describe('complete event', () => {
    it('emits complete event with elapsed time', async () => {
      const queue = new JobQueue(db);
      const job = await queue.enqueue({
        jobType: 'embed_chunk',
        payload: { chunkId: 'c1' },
        queue: 'embeddings',
      });
      const claimed = await queue.claim({ leaseMs: 5000, queue: 'embeddings' });

      events = []; // Clear previous events

      await queue.complete({
        id: claimed?.id ?? '',
        leaseToken: claimed?.lease_token ?? '',
      });

      const completeEvent = events.find((e) => e.event === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.taskId).toBe(job.id);
      expect(completeEvent?.elapsedMs).toBeDefined();
      expect(typeof completeEvent?.elapsedMs).toBe('number');
      expect(completeEvent?.metadata).toMatchObject({
        jobType: 'embed_chunk',
        queue: 'embeddings',
      });
    });
  });

  describe('error event', () => {
    it('emits error event with retry info for retriable failure', async () => {
      const queue = new JobQueue(db, { maxAttempts: 3 });
      const job = await queue.enqueue({
        jobType: 'embed_chunk',
        payload: { chunkId: 'c1' },
        queue: 'embeddings',
      });
      const claimed = await queue.claim({ leaseMs: 5000, queue: 'embeddings' });

      events = []; // Clear previous events

      await queue.fail({
        error: 'Test error message',
        id: claimed?.id ?? '',
        leaseToken: claimed?.lease_token ?? '',
      });

      const errorEvent = events.find((e) => e.event === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.taskId).toBe(job.id);
      expect(errorEvent?.errorMessage).toBe('Test error message');
      expect(errorEvent?.metadata).toMatchObject({
        attempts: 1,
        jobType: 'embed_chunk',
        queue: 'embeddings',
      });
      expect(errorEvent?.metadata?.retryAt).toBeDefined(); // Retry scheduled
    });

    it('emits error event with terminal flag for permanent failure', async () => {
      const queue = new JobQueue(db, { maxAttempts: 1 });
      await queue.enqueue({
        jobType: 'embed_chunk',
        payload: { chunkId: 'c1' },
        queue: 'embeddings',
      });
      const claimed = await queue.claim({ leaseMs: 5000, queue: 'embeddings' });

      events = []; // Clear previous events

      await queue.fail({
        error: 'Terminal failure',
        id: claimed?.id ?? '',
        leaseToken: claimed?.lease_token ?? '',
        terminal: true,
      });

      const errorEvent = events.find((e) => e.event === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.errorMessage).toBe('Terminal failure');
      expect(errorEvent?.metadata?.terminal).toBe(true);
    });
  });

  describe('cancel event', () => {
    it('emits cancel event when job is canceled', async () => {
      const queue = new JobQueue(db);
      const job = await queue.enqueue({
        jobType: 'embed_chunk',
        payload: { chunkId: 'c1' },
        queue: 'embeddings',
      });

      events = []; // Clear enqueue event

      await queue.cancel({ id: job.id, reason: 'User requested cancellation' });

      const cancelEvent = events.find((e) => e.event === 'cancel');
      expect(cancelEvent).toBeDefined();
      expect(cancelEvent?.taskId).toBe(job.id);
      expect(cancelEvent?.metadata).toMatchObject({
        jobType: 'embed_chunk',
        queue: 'embeddings',
        reason: 'User requested cancellation',
      });
    });

    it('emits cancel events for all jobs in cancelMany', async () => {
      const queue = new JobQueue(db);
      await queue.enqueue({
        jobType: 'embed_chunk',
        payload: { chunkId: 'c1' },
        queue: 'embeddings',
      });
      await queue.enqueue({
        jobType: 'embed_chunk',
        payload: { chunkId: 'c2' },
        queue: 'embeddings',
      });

      events = []; // Clear enqueue events

      const cancelCount = await queue.cancelMany('embeddings', 'Bulk cancel test');

      expect(cancelCount).toBe(2);
      const cancelEvents = events.filter((e) => e.event === 'cancel');
      expect(cancelEvents.length).toBe(2);
      expect(cancelEvents.every((e) => e.metadata?.bulkCancel === true)).toBe(true);
      expect(cancelEvents.every((e) => e.metadata?.reason === 'Bulk cancel test')).toBe(true);
    });

    it('does not emit cancel event if job not found', async () => {
      const queue = new JobQueue(db);

      const result = await queue.cancel({ id: 'non-existent-id' });

      expect(result).toBeNull();
      const cancelEvents = events.filter((e) => e.event === 'cancel');
      expect(cancelEvents.length).toBe(0);
    });
  });

  describe('telemetry aggregation compatibility', () => {
    it('events can be consumed by telemetry aggregator', async () => {
      const queue = new JobQueue(db);
      await queue.enqueue({
        jobType: 'embed_chunk',
        payload: { chunkId: 'c1' },
        queue: 'embeddings',
      });
      const claimed = await queue.claim({ leaseMs: 5000, queue: 'embeddings' });
      await queue.complete({
        id: claimed?.id ?? '',
        leaseToken: claimed?.lease_token ?? '',
      });

      // Verify all expected events were emitted
      const eventTypes = events.map((e) => e.event);
      expect(eventTypes).toContain('enqueue');
      expect(eventTypes).toContain('start');
      expect(eventTypes).toContain('complete');

      // Verify all events have required fields for aggregator
      for (const event of events) {
        expect(event.timestamp).toBeDefined();
        expect(typeof event.timestamp).toBe('number');
        expect(event.adapter).toBe('job-queue');
        expect(event.taskId).toBeDefined();
      }
    });
  });
});
