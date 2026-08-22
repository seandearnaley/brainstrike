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

const WINDOWS = { firstOutputMs: 5000, interOutputMs: 1000 } as const;

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

  it('tolerates a first output slower than the inter-output window', async () => {
    // BST-1408: a cold request with a large prompt at high reasoning effort can
    // take minutes to emit ANYTHING. Under the single-window watchdog this was
    // indistinguishable from a wedged transport and killed the whole turn.
    const source = createControllableSource<string>();
    const seen: string[] = [];
    const drain = (async () => {
      for await (const part of withInactivityTimeout(source.iterate(), {
        firstOutputMs: 60_000,
        interOutputMs: 1000,
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

  it('reports an awaiting-output stall with the phase, the window, and zero parts seen', async () => {
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

    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs);
    await settled;

    expect(captured?.phase).toBe('awaiting-output');
    expect(captured?.inactivityMs).toBe(WINDOWS.firstOutputMs);
    expect(captured?.partsSeen).toBe(0);
    expect(captured?.lastPartType).toBeUndefined();
  });

  it('reports a streaming stall with the last part type and the parts seen', async () => {
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
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs);
    await settled;

    expect(captured?.phase).toBe('streaming');
    expect(captured?.inactivityMs).toBe(WINDOWS.interOutputMs);
    expect(captured?.partsSeen).toBe(2);
    expect(captured?.lastPartType).toBe('reasoning-delta');
  });

  it('applies the inter-output window to every gap, not only the first one', async () => {
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
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs - 1);
    source.push('b');
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs - 1);
    source.push('c');
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs);
    await settled;

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(captured?.partsSeen).toBe(3);
  });

  it('re-arms the wide window when scaffolding opens a new step', async () => {
    // The failure this exists to prevent: Mastra emits an instant `start` and a
    // fresh `step-start` per step, so a rule that ends the wide window at the
    // first RAW part measures every real time-to-first-token — including
    // mid-turn ones — against the tight window.
    const source = createControllableSource<{ type: string }>();
    const seen: string[] = [];
    const drain = (async () => {
      for await (const part of withInactivityTimeout(
        source.iterate(),
        { firstOutputMs: 10_000, interOutputMs: 500 },
        {
          countsAsProviderOutput: (part) => part.type !== 'start' && part.type !== 'step-start',
          describePart: (part) => part.type,
        }
      )) {
        seen.push(part.type);
      }
    })();

    source.push({ type: 'start' });
    source.push({ type: 'step-start' });
    await vi.advanceTimersByTimeAsync(0);
    // Step 1's think time: far beyond the tight window, inside the wide one.
    await vi.advanceTimersByTimeAsync(5000);
    source.push({ type: 'tool-call' });
    await vi.advanceTimersByTimeAsync(0);
    // A new step re-arms it, so step 2 gets its own budget rather than
    // inheriting step 1's `streaming` phase.
    source.push({ type: 'step-start' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    source.push({ type: 'text-delta' });
    await vi.advanceTimersByTimeAsync(0);
    source.finish();
    await drain;

    expect(seen).toEqual(['start', 'step-start', 'tool-call', 'step-start', 'text-delta']);
  });

  it('still enforces the tight window once the provider is producing output', async () => {
    const source = createControllableSource<{ type: string }>();
    let captured: StreamStalledError | undefined;
    const drain = (async () => {
      for await (const _part of withInactivityTimeout(
        source.iterate(),
        { firstOutputMs: 10_000, interOutputMs: 500 },
        { countsAsProviderOutput: (part) => part.type !== 'step-start' }
      )) {
        // Drain until the gap after real output.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ type: 'step-start' });
    source.push({ type: 'text-delta' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    await settled;

    expect(captured?.phase).toBe('streaming');
    expect(captured?.inactivityMs).toBe(500);
  });

  it('keeps the last NAMED part when a later part cannot be described', async () => {
    // Overwriting with `undefined` would erase the breadcrumb and land the
    // diagnostic back in "we saw N parts and cannot say what any were".
    const source = createControllableSource<{ type?: string }>();
    let captured: StreamStalledError | undefined;
    const drain = (async () => {
      for await (const _part of withInactivityTimeout(source.iterate(), WINDOWS, {
        describePart: (part) => part.type,
      })) {
        // Drain until the stall.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ type: 'reasoning-delta' });
    source.push({});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs);
    await settled;

    expect(captured?.partsSeen).toBe(2);
    expect(captured?.lastPartType).toBe('reasoning-delta');
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
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs);
    await settled;

    expect(timeoutError).toBeInstanceOf(StreamStalledError);
    expect(timeoutError?.inactivityMs).toBe(WINDOWS.interOutputMs);
    expect(timeoutError?.phase).toBe('streaming');
  });
});
