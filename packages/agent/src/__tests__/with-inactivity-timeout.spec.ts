import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamStalledError, withInactivityTimeout } from '../stream/with-inactivity-timeout';

/**
 * The watchdog owns the ONLY timers under test, so fake time keeps every case
 * deterministic and in the cacheable unit lane. Cases whose verdict depends on
 * real host scheduling belong in `mastra-stream-watchdogs.integration.spec.ts`
 * instead (docs/agents/assistant-runtime.md).
 */

interface ControllableSource<T> {
  finish(): void;
  iterate(): AsyncIterableIterator<T>;
  push(value: T): void;
}

function createControllableSource<T>(): ControllableSource<T> {
  const queue: T[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const notify = (): void => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  return {
    finish() {
      done = true;
      notify();
    },
    async *iterate() {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift() as T;
        }
        if (done) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    push(value) {
      queue.push(value);
      notify();
    },
  };
}

async function* immediate(values: number[]): AsyncIterableIterator<number> {
  for (const value of values) {
    yield value;
  }
}

const WINDOWS = { firstPartMs: 5000, interPartMs: 1000 } as const;

describe('withInactivityTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes through all items when the source is active', async () => {
    const out: number[] = [];
    for await (const value of withInactivityTimeout(immediate([1, 2, 3]), WINDOWS)) {
      out.push(value);
    }
    expect(out).toEqual([1, 2, 3]);
  });

  it('tolerates a first part slower than the inter-part window', async () => {
    // BST-1408: a cold request with a large prompt at high reasoning effort can
    // take minutes to emit ANYTHING. Under the single-window watchdog this was
    // indistinguishable from a wedged transport and killed the whole turn.
    const source = createControllableSource<string>();
    const seen: string[] = [];
    const drain = (async () => {
      for await (const part of withInactivityTimeout(source.iterate(), {
        firstPartMs: 60_000,
        interPartMs: 1000,
      })) {
        seen.push(part);
      }
    })();

    await vi.advanceTimersByTimeAsync(30_000);
    source.push('reasoning-delta');
    await vi.advanceTimersByTimeAsync(0);
    source.finish();
    await drain;

    expect(seen).toEqual(['reasoning-delta']);
  });

  it('reports a first-part stall with the phase, the window, and zero parts seen', async () => {
    const source = createControllableSource<string>();
    let captured: StreamStalledError | undefined;

    const drain = (async () => {
      for await (const _part of withInactivityTimeout(source.iterate(), WINDOWS)) {
        // Never reached: nothing is ever pushed.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    await vi.advanceTimersByTimeAsync(WINDOWS.firstPartMs);
    await settled;

    expect(captured?.phase).toBe('first-part');
    expect(captured?.inactivityMs).toBe(WINDOWS.firstPartMs);
    expect(captured?.partsSeen).toBe(0);
    expect(captured?.lastPartType).toBeUndefined();
  });

  it('reports an inter-part stall with the last part type and the parts seen', async () => {
    // The 2026-08-22 incident had to be reconstructed by inference because the
    // diagnostic recorded only the window. Knowing WHAT the provider last sent
    // (and how much) is what makes this class provable from a debug bundle.
    const source = createControllableSource<{ type: string }>();
    let captured: StreamStalledError | undefined;

    const drain = (async () => {
      for await (const _part of withInactivityTimeout(source.iterate(), WINDOWS, {
        describePart: (part) => part.type,
      })) {
        // Drain until the source goes silent.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ type: 'step-start' });
    source.push({ type: 'reasoning-delta' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(WINDOWS.interPartMs);
    await settled;

    expect(captured?.phase).toBe('inter-part');
    expect(captured?.inactivityMs).toBe(WINDOWS.interPartMs);
    expect(captured?.partsSeen).toBe(2);
    expect(captured?.lastPartType).toBe('reasoning-delta');
  });

  it('applies the inter-part window to every gap, not only the first one', async () => {
    const source = createControllableSource<string>();
    const seen: string[] = [];
    let captured: StreamStalledError | undefined;

    const drain = (async () => {
      for await (const part of withInactivityTimeout(source.iterate(), WINDOWS)) {
        seen.push(part);
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push('a');
    await vi.advanceTimersByTimeAsync(WINDOWS.interPartMs - 1);
    source.push('b');
    await vi.advanceTimersByTimeAsync(WINDOWS.interPartMs - 1);
    source.push('c');
    await vi.advanceTimersByTimeAsync(WINDOWS.interPartMs);
    await settled;

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(captured?.partsSeen).toBe(3);
  });

  it('notifies the owner to cancel source work without changing the stall error', async () => {
    const source = createControllableSource<string>();
    let timeoutError: StreamStalledError | undefined;

    const drain = (async () => {
      for await (const _value of withInactivityTimeout(source.iterate(), WINDOWS, {
        onTimeout: (error) => {
          timeoutError = error;
        },
      })) {
        // Drain until the source stalls.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);

    source.push('a');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(WINDOWS.interPartMs);
    await settled;

    expect(timeoutError).toBeInstanceOf(StreamStalledError);
    expect(timeoutError?.inactivityMs).toBe(WINDOWS.interPartMs);
    expect(timeoutError?.phase).toBe('inter-part');
  });
});
