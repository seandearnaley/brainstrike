// packages/embeddings/src/worker/__tests__/foreground-embedding-gate.spec.ts
import { describe, expect, it, vi } from 'vitest';
import {
  createForegroundEmbeddingGate,
  runCoordinatedQueryEmbedding,
  waitForWorkerIdle,
} from '../foreground-embedding-gate';

describe('createForegroundEmbeddingGate', () => {
  it('is inactive initially and waitUntilInactive resolves immediately', async () => {
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 10 });
    expect(gate.isActive()).toBe(false);
    await expect(gate.waitUntilInactive()).resolves.toBeUndefined();
  });

  it('closes on begin and reopens after the debounce on end', async () => {
    vi.useFakeTimers();
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 50 });
    gate.begin();
    expect(gate.isActive()).toBe(true);
    let resolved = false;
    const waiter = gate.waitUntilInactive().then(() => {
      resolved = true;
    });
    gate.end();
    expect(gate.isActive()).toBe(true); // still within debounce window
    await vi.advanceTimersByTimeAsync(49);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await waiter;
    expect(resolved).toBe(true);
    expect(gate.isActive()).toBe(false);
    vi.useRealTimers();
  });

  it('ref-counts overlapping begins so the gate stays closed until all end', () => {
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 10 });
    gate.begin();
    gate.begin();
    gate.end();
    expect(gate.isActive()).toBe(true);
  });

  it('a begin during the reopen debounce cancels the reopen', async () => {
    vi.useFakeTimers();
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 50 });
    gate.begin();
    gate.end();
    await vi.advanceTimersByTimeAsync(20);
    gate.begin(); // cancels pending reopen
    await vi.advanceTimersByTimeAsync(60);
    expect(gate.isActive()).toBe(true);
    vi.useRealTimers();
  });

  it('rejects a pending waitUntilInactive when the signal aborts', async () => {
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 1000 });
    gate.begin();
    const controller = new AbortController();
    const waiter = gate.waitUntilInactive({ signal: controller.signal });
    controller.abort();
    await expect(waiter).rejects.toThrow(/aborted/i);
  });
});

describe('waitForWorkerIdle', () => {
  it('resolves drained=true as soon as isActive is false', async () => {
    const res = await waitForWorkerIdle({ isActive: () => false, timeoutMs: 100, pollMs: 5 });
    expect(res.drained).toBe(true);
  });

  it('resolves drained=false on timeout when isActive stays true', async () => {
    const res = await waitForWorkerIdle({ isActive: () => true, timeoutMs: 30, pollMs: 5 });
    expect(res.drained).toBe(false);
  });

  it('resolves drained=true once isActive flips to false', async () => {
    let active = true;
    setTimeout(() => {
      active = false;
    }, 15);
    const res = await waitForWorkerIdle({ isActive: () => active, timeoutMs: 200, pollMs: 5 });
    expect(res.drained).toBe(true);
  });
});

describe('runCoordinatedQueryEmbedding', () => {
  it('drains before generating and always releases the gate', async () => {
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 5 });
    const order: string[] = [];
    let active = true;
    setTimeout(() => {
      active = false;
    }, 10);
    const result = await runCoordinatedQueryEmbedding({
      gate,
      isWorkerActive: () => active,
      drainTimeoutMs: 200,
      pollMs: 2,
      generate: async () => {
        order.push(`generate(active=${active})`);
        return 42;
      },
    });
    expect(result).toBe(42);
    expect(order).toEqual(['generate(active=false)']); // generated only after drain
  });

  it('releases the gate even when generate throws', async () => {
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 1 });
    await expect(
      runCoordinatedQueryEmbedding({
        gate,
        isWorkerActive: () => false,
        drainTimeoutMs: 50,
        generate: async () => {
          throw new Error('boom');
        },
      })
    ).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 5));
    expect(gate.isActive()).toBe(false);
  });

  it('calls onDrainTimeout but still generates when drain times out', async () => {
    const gate = createForegroundEmbeddingGate({ reopenDelayMs: 1 });
    const onDrainTimeout = vi.fn();
    const result = await runCoordinatedQueryEmbedding({
      gate,
      isWorkerActive: () => true, // never drains
      drainTimeoutMs: 20,
      pollMs: 5,
      onDrainTimeout,
      generate: async () => 7,
    });
    expect(result).toBe(7);
    expect(onDrainTimeout).toHaveBeenCalledTimes(1);
  });
});
