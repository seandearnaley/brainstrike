import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticEventWriter } from '../diagnostics/diagnostic-event-writer';
import type { DiagnosticEvent } from '../diagnostics/diagnostic-events';

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
});
