// @vitest-environment node
import { parseLifecycleDelays } from '@brainstrike/host-lease/lifecycle-delays';
import { afterEach, expect, it, vi } from 'vitest';
import { indexerMessageDelivery } from '../indexer-request-delay';

afterEach(() => {
  vi.useRealTimers();
});

const request = (id: number) => ({ id, op: 'info', payload: null });

it('delivers synchronously, through the listener itself, when indexer-request is unset', () => {
  const listener = vi.fn();
  for (const delays of [new Map(), parseLifecycleDelays('canonical-attach:7000')]) {
    const deliver = indexerMessageDelivery(delays, listener);
    expect(deliver).toBe(listener);
    deliver(request(1));
    expect(listener).toHaveBeenLastCalledWith(request(1));
  }
});

it('holds the first indexer request once, keeping every message in order', async () => {
  vi.useFakeTimers();
  const delivered: unknown[] = [];
  const deliver = indexerMessageDelivery(parseLifecycleDelays('indexer-request:7000'), (message) =>
    delivered.push(message)
  );
  const options = { dbPath: '/index.sqlite' };
  const canonical = { channel: 'canonical-ingestion-v1', id: 1, kind: 'call' };
  deliver(options);
  deliver(request(1));
  deliver(canonical);
  deliver(request(2));

  await vi.advanceTimersByTimeAsync(0);
  expect(delivered).toEqual([options]);
  await vi.advanceTimersByTimeAsync(6999);
  expect(delivered).toEqual([options]);
  await vi.advanceTimersByTimeAsync(1);
  expect(delivered).toEqual([options, request(1), canonical, request(2)]);

  // Fired once: a later request is not held.
  deliver(request(3));
  await vi.advanceTimersByTimeAsync(0);
  expect(delivered.at(-1)).toEqual(request(3));
});
