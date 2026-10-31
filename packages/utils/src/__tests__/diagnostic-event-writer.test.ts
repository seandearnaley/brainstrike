import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticEventWriter } from '../diagnostics/diagnostic-event-writer.js';
import type { DiagnosticEvent } from '../diagnostics/diagnostic-events.js';

function makeEvent(id: string): DiagnosticEvent {
  return {
    appVersion: 'v',
    causeChain: null,
    code: null,
    context: null,
    fingerprint: 'f',
    id,
    message: 'm',
    occurredAt: 1,
    platform: 'p',
    resourceId: null,
    rootId: null,
    runId: null,
    scope: null,
    sessionId: 's',
    severity: 'error',
    source: 'test',
    stack: null,
    threadId: null,
  };
}

describe('DiagnosticEventWriter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([-1, 2.5, Number.POSITIVE_INFINITY])('rejects invalid maxPending %s', (maxPending) => {
    expect(
      () =>
        new DiagnosticEventWriter({
          makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
          maxPending,
          sink: { insertBatch: async () => undefined },
        })
    ).toThrow('DiagnosticEventWriter maxPending must be a non-negative integer');
  });

  it('flushes on the batch-size threshold', async () => {
    const inserted: DiagnosticEvent[][] = [];
    const writer = new DiagnosticEventWriter({
      flushBatchSize: 2,
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      sink: { insertBatch: async (events) => void inserted.push([...events]) },
    });
    writer.enqueue(makeEvent('a'));
    writer.enqueue(makeEvent('b'));
    await vi.runOnlyPendingTimersAsync();
    expect(inserted.flat().map((event) => event.id)).toEqual(['a', 'b']);
    await writer.dispose();
  });

  it('flushes on the interval', async () => {
    const inserted: DiagnosticEvent[] = [];
    const writer = new DiagnosticEventWriter({
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      sink: { insertBatch: async (events) => void inserted.push(...events) },
    });
    writer.enqueue(makeEvent('a'));
    await vi.advanceTimersByTimeAsync(2001);
    expect(inserted.map((event) => event.id)).toEqual(['a']);
    await writer.dispose();
  });

  it('drops oldest past maxPending and reports the loss loudly', async () => {
    const inserted: DiagnosticEvent[] = [];
    const writer = new DiagnosticEventWriter({
      flushIntervalMs: 60_000,
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      maxPending: 2,
      sink: { insertBatch: async (events) => void inserted.push(...events) },
    });
    writer.enqueue(makeEvent('a'));
    writer.enqueue(makeEvent('b'));
    writer.enqueue(makeEvent('c')); // drops 'a'
    await writer.flush();
    expect(inserted.map((event) => event.id)).toEqual(['dropped-1', 'b', 'c']);
    await writer.dispose();
  });

  it('preserves retained order across repeated ring-buffer wraps', async () => {
    const inserted: DiagnosticEvent[] = [];
    const writer = new DiagnosticEventWriter({
      flushIntervalMs: 60_000,
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      maxPending: 3,
      sink: { insertBatch: async (events) => void inserted.push(...events) },
    });
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      writer.enqueue(makeEvent(id));
    }

    await writer.flush();

    expect(inserted.map((event) => event.id)).toEqual(['dropped-5', 'f', 'g', 'h']);
    await writer.dispose();
  });

  it('does not shift the pending array when overwriting saturated entries', async () => {
    const writer = new DiagnosticEventWriter({
      flushIntervalMs: 60_000,
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      maxPending: 2,
      sink: { insertBatch: async () => undefined },
    });
    const originalShift = Array.prototype.shift;
    let shiftCalls = 0;
    Array.prototype.shift = function shift<T>(this: T[]): T | undefined {
      shiftCalls += 1;
      return originalShift.call(this) as T | undefined;
    };
    try {
      writer.enqueue(makeEvent('a'));
      writer.enqueue(makeEvent('b'));
      writer.enqueue(makeEvent('c'));
    } finally {
      Array.prototype.shift = originalShift;
    }

    expect(shiftCalls).toBe(0);
    await writer.dispose();
  });

  it('disables after maxConsecutiveFailures and reports once', async () => {
    const onDisabled = vi.fn();
    const writer = new DiagnosticEventWriter({
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      maxConsecutiveFailures: 2,
      onDisabled,
      sink: {
        insertBatch: async () => {
          throw new Error('db down');
        },
      },
    });
    writer.enqueue(makeEvent('a'));
    await writer.flush();
    expect(writer.disabled).toBe(false);
    await writer.flush();
    expect(writer.disabled).toBe(true);
    expect(onDisabled).toHaveBeenCalledTimes(1);
    writer.enqueue(makeEvent('b')); // no-op, must not throw
    await writer.dispose();
  });

  it('dispose-during-in-flight: captures events enqueued while sink promise is pending', async () => {
    const { promise: sinkPromise, resolve: resolveSink } = Promise.withResolvers<void>();
    const inserted: DiagnosticEvent[][] = [];
    const writer = new DiagnosticEventWriter({
      flushBatchSize: 2,
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      sink: {
        insertBatch: async (events) => {
          inserted.push([...events]);
          await sinkPromise;
        },
      },
    });
    writer.enqueue(makeEvent('a'));
    writer.enqueue(makeEvent('b')); // triggers flush
    await vi.runOnlyPendingTimersAsync();
    // Flush is in-flight; sink call is pending
    writer.enqueue(makeEvent('c'));
    writer.enqueue(makeEvent('d')); // triggers another flush, but joins the drain
    // Now resolve the sink
    resolveSink!();
    await writer.dispose();
    // Both waves should be inserted
    expect(inserted.flat().map((event) => event.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('marker survives retry: dropped counter not eaten by overflow during requeue', async () => {
    let callCount = 0;
    const inserted: DiagnosticEvent[] = [];
    const writer = new DiagnosticEventWriter({
      flushIntervalMs: 60_000,
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      maxPending: 2,
      sink: {
        insertBatch: async (events) => {
          callCount += 1;
          if (callCount === 1) {
            throw new Error('first attempt fails');
          }
          inserted.push(...events);
        },
      },
    });
    // Overflow by two to set droppedCount=2 (discriminates old code's undercount)
    writer.enqueue(makeEvent('a'));
    writer.enqueue(makeEvent('b'));
    writer.enqueue(makeEvent('c')); // drops 'a', droppedCount=1
    writer.enqueue(makeEvent('d')); // drops 'b', droppedCount=2
    await writer.flush(); // first attempt fails
    // Now flush succeeds
    await writer.flush();
    // The successful insert should include the marker with count 2 (not undercount to 1)
    expect(inserted.map((event) => event.id)).toEqual(['dropped-2', 'c', 'd']);
  });

  it('keeps wrapped batches chronological across a failed flush and later overflow', async () => {
    let callCount = 0;
    const inserted: DiagnosticEvent[] = [];
    const writer = new DiagnosticEventWriter({
      flushIntervalMs: 60_000,
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      maxPending: 3,
      sink: {
        insertBatch: async (events) => {
          callCount += 1;
          if (callCount === 1) {
            throw new Error('first attempt fails');
          }
          inserted.push(...events);
        },
      },
    });
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      writer.enqueue(makeEvent(id));
    }
    await writer.flush();
    writer.enqueue(makeEvent('f'));
    writer.enqueue(makeEvent('g'));

    await writer.flush();

    expect(inserted.map((event) => event.id)).toEqual(['dropped-4', 'e', 'f', 'g']);
    await writer.dispose();
  });

  it('failed-flush requeue preserves order with later enqueues', async () => {
    let callCount = 0;
    const inserted: DiagnosticEvent[] = [];
    const writer = new DiagnosticEventWriter({
      flushBatchSize: 10,
      flushIntervalMs: 60_000,
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      sink: {
        insertBatch: async (events) => {
          callCount += 1;
          if (callCount === 1) {
            throw new Error('first attempt fails');
          }
          inserted.push(...events);
        },
      },
    });
    writer.enqueue(makeEvent('a'));
    writer.enqueue(makeEvent('b'));
    await writer.flush(); // first attempt fails, requeues [a, b]
    writer.enqueue(makeEvent('c')); // added to requeue
    await writer.flush(); // succeeds
    expect(inserted.map((event) => event.id)).toEqual(['a', 'b', 'c']);
  });
});
