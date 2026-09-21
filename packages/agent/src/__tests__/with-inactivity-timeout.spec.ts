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

const WINDOWS = {
  firstOutputMs: 5000,
  interOutputMs: 1000,
  reasoningGapMs: 5000,
  toolExecutingMs: 60_000,
} as const;

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
        reasoningGapMs: 60_000,
        toolExecutingMs: 60_000,
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
        {
          firstOutputMs: 10_000,
          interOutputMs: 500,
          reasoningGapMs: 10_000,
          toolExecutingMs: 60_000,
        },
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
        {
          firstOutputMs: 10_000,
          interOutputMs: 500,
          reasoningGapMs: 10_000,
          toolExecutingMs: 60_000,
        },
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

describe('withInactivityTimeout — reasoning phase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Mirrors the Mastra wiring: reasoning parts are output, but not an answer. */
  const REASONING_OPTIONS = {
    countsAsProviderOutput: (part: { type: string }) =>
      part.type !== 'start' && part.type !== 'step-start',
    describePart: (part: { type: string }) => part.type,
    reasoningPartKind: (part: { type: string }) => {
      if (part.type === 'reasoning-end' || part.type === 'reasoning-signature') {
        return 'marker' as const;
      }
      return part.type.startsWith('reasoning') ? ('content' as const) : undefined;
    },
  };

  const REASONING_WINDOWS = {
    firstOutputMs: 10_000,
    interOutputMs: 1000,
    reasoningGapMs: 10_000,
    toolExecutingMs: 60_000,
  } as const;

  it('survives a think-pause longer than the inter-output window', async () => {
    // THE BUG: google/gemini-3.7-flash at reasoning.effort 'high' emits a burst
    // of thought, pauses to think further, then continues. The first delta had
    // been counted as "the provider started answering", so that pause was
    // measured against the tight window and killed both attempts of the turn.
    const source = createControllableSource<{ type: string }>();
    const seen: string[] = [];
    const drain = (async () => {
      for await (const part of withInactivityTimeout(
        source.iterate(),
        REASONING_WINDOWS,
        REASONING_OPTIONS
      )) {
        seen.push(part.type);
      }
    })();

    source.push({ type: 'reasoning-start' });
    source.push({ type: 'reasoning-delta' });
    await vi.advanceTimersByTimeAsync(0);
    // Five times the inter-output window, well inside the reasoning window.
    await vi.advanceTimersByTimeAsync(5000);
    source.push({ type: 'reasoning-delta' });
    await vi.advanceTimersByTimeAsync(0);
    source.finish();
    await drain;

    expect(seen).toEqual(['reasoning-start', 'reasoning-delta', 'reasoning-delta']);
  });

  it('still bounds reasoning, and names the phase that fired', async () => {
    // Wide is not unbounded: a provider that reasons forever must not hold the
    // turn open, and the diagnostic must say which of the three silences fired.
    const source = createControllableSource<{ type: string }>();
    let captured: StreamStalledError | undefined;

    const drain = (async () => {
      for await (const _part of withInactivityTimeout(
        source.iterate(),
        REASONING_WINDOWS,
        REASONING_OPTIONS
      )) {
        // Drain until the model stops thinking out loud.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ type: 'reasoning-delta' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(REASONING_WINDOWS.reasoningGapMs);
    await settled;

    expect(captured?.phase).toBe('reasoning');
    expect(captured?.inactivityMs).toBe(REASONING_WINDOWS.reasoningGapMs);
    expect(captured?.lastPartType).toBe('reasoning-delta');
  });

  it('re-tightens once the answer starts', async () => {
    // The widening must not leak: once a text delta proves the model IS
    // answering, a two-minute gap is suspicious again. Without this the fix
    // would trade one bug for a much worse one — a wedged provider mid-answer
    // holding the turn for the full reasoning budget.
    const source = createControllableSource<{ type: string }>();
    let captured: StreamStalledError | undefined;

    const drain = (async () => {
      for await (const _part of withInactivityTimeout(
        source.iterate(),
        REASONING_WINDOWS,
        REASONING_OPTIONS
      )) {
        // Drain.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ type: 'reasoning-delta' });
    source.push({ type: 'text-delta' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(REASONING_WINDOWS.interOutputMs);
    await settled;

    expect(captured?.phase).toBe('streaming');
    expect(captured?.inactivityMs).toBe(REASONING_WINDOWS.interOutputMs);
    expect(captured?.lastPartType).toBe('text-delta');
  });

  it('widens again when thinking resumes after text (interleaved reasoning)', async () => {
    // Interleaved thinking is normal on these models, not a state error: the
    // phase must be able to move back, or the first text delta would pin the
    // rest of the step to the tight window and reintroduce the bug.
    const source = createControllableSource<{ type: string }>();
    const seen: string[] = [];
    const drain = (async () => {
      for await (const part of withInactivityTimeout(
        source.iterate(),
        REASONING_WINDOWS,
        REASONING_OPTIONS
      )) {
        seen.push(part.type);
      }
    })();

    source.push({ type: 'text-delta' });
    source.push({ type: 'reasoning-delta' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    source.push({ type: 'text-delta' });
    await vi.advanceTimersByTimeAsync(0);
    source.finish();
    await drain;

    expect(seen).toEqual(['text-delta', 'reasoning-delta', 'text-delta']);
  });

  it('treats reasoning-end as still-not-answering', async () => {
    // reasoning-end marks the end of a thinking block, not the start of an
    // answer. The gap between it and the first text delta is still
    // "has the provider begun answering?" — the wide window's question.
    const source = createControllableSource<{ type: string }>();
    const seen: string[] = [];
    const drain = (async () => {
      for await (const part of withInactivityTimeout(
        source.iterate(),
        REASONING_WINDOWS,
        REASONING_OPTIONS
      )) {
        seen.push(part.type);
      }
    })();

    source.push({ type: 'reasoning-end' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    source.push({ type: 'text-delta' });
    await vi.advanceTimersByTimeAsync(0);
    source.finish();
    await drain;

    expect(seen).toEqual(['reasoning-end', 'text-delta']);
  });

  it('lets scaffolding re-arm the first-output window even after reasoning', async () => {
    // A new step must not inherit `reasoning` any more than it inherits
    // `streaming`; each step gets its own time-to-first-output.
    const source = createControllableSource<{ type: string }>();
    let captured: StreamStalledError | undefined;

    const drain = (async () => {
      for await (const _part of withInactivityTimeout(
        source.iterate(),
        REASONING_WINDOWS,
        REASONING_OPTIONS
      )) {
        // Drain.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ type: 'reasoning-delta' });
    source.push({ type: 'step-start' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(REASONING_WINDOWS.firstOutputMs);
    await settled;

    expect(captured?.phase).toBe('awaiting-output');
    expect(captured?.inactivityMs).toBe(REASONING_WINDOWS.firstOutputMs);
  });

  it('does not re-widen when reasoning-end arrives AFTER the answer started', async () => {
    // Some providers emit `text-start` before `reasoning-end`. Treating the end
    // marker as content would flip an already-answering stream back to the wide
    // window at exactly the wrong moment, so a marker preserves the phase
    // instead of setting it.
    const source = createControllableSource<{ type: string }>();
    let captured: StreamStalledError | undefined;

    const drain = (async () => {
      for await (const _part of withInactivityTimeout(
        source.iterate(),
        REASONING_WINDOWS,
        REASONING_OPTIONS
      )) {
        // Drain.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ type: 'reasoning-delta' });
    source.push({ type: 'text-delta' });
    source.push({ type: 'reasoning-end' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(REASONING_WINDOWS.interOutputMs);
    await settled;

    expect(captured?.phase).toBe('streaming');
    expect(captured?.inactivityMs).toBe(REASONING_WINDOWS.interOutputMs);
  });
});

describe('withInactivityTimeout — tool-executing phase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  interface ToolPart {
    readonly id?: string;
    readonly type: string;
  }

  /** Mirrors a minimal tool-call/tool-result boundary classifier. */
  const toolExecutionPartKind = (part: ToolPart) => {
    if (part.type === 'tool-call') {
      return { kind: 'started' as const, toolCallId: part.id as string };
    }
    if (part.type === 'tool-result') {
      return { kind: 'settled' as const, toolCallId: part.id as string };
    }
    return;
  };

  const TOOL_WINDOWS = {
    firstOutputMs: 1000,
    interOutputMs: 100,
    reasoningGapMs: 1000,
    toolExecutingMs: 5000,
  } as const;

  it('does not treat a running tool as a stalled provider', async () => {
    const source = createControllableSource<ToolPart>();
    const seen: string[] = [];
    const drain = (async () => {
      for await (const part of withInactivityTimeout(source.iterate(), TOOL_WINDOWS, {
        describePart: (part) => part.type,
        toolExecutionPartKind,
      })) {
        seen.push(part.type);
      }
    })();

    source.push({ id: 'a', type: 'tool-call' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4000);
    source.push({ id: 'a', type: 'tool-result' });
    await vi.advanceTimersByTimeAsync(0);
    source.finish();
    await drain;

    expect(seen).toEqual(['tool-call', 'tool-result']);
  });

  it('is a finite backstop against a broken execution guard', async () => {
    const source = createControllableSource<ToolPart>();
    let captured: StreamStalledError | undefined;
    const drain = (async () => {
      for await (const _part of withInactivityTimeout(source.iterate(), TOOL_WINDOWS, {
        describePart: (part) => part.type,
        toolExecutionPartKind,
      })) {
        // Drain until the backstop fires.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ id: 'a', type: 'tool-call' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5001);
    await settled;

    expect(captured?.phase).toBe('tool-executing');
    expect(captured?.inactivityMs).toBe(TOOL_WINDOWS.toolExecutingMs);
  });

  it('reference-counts parallel calls, holding the phase until the last settles', async () => {
    const source = createControllableSource<ToolPart>();
    let captured: StreamStalledError | undefined;
    let timeoutsFired = 0;
    const drain = (async () => {
      for await (const _part of withInactivityTimeout(source.iterate(), TOOL_WINDOWS, {
        describePart: (part) => part.type,
        onTimeout: () => {
          timeoutsFired += 1;
        },
        toolExecutionPartKind,
      })) {
        // Drain until b's settle re-tightens the window.
      }
    })();
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ id: 'a', type: 'tool-call' });
    source.push({ id: 'b', type: 'tool-call' });
    source.push({ id: 'a', type: 'tool-result' });
    await vi.advanceTimersByTimeAsync(0);
    // b is still running, so the backstop window applies, not the tight one:
    // this silence must NOT trip the watchdog even though it dwarfs 100ms.
    await vi.advanceTimersByTimeAsync(4000);
    expect(timeoutsFired).toBe(0);

    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    source.push({ id: 'b', type: 'tool-result' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(101);
    await settled;

    expect(captured?.phase).toBe('streaming');
  });

  it('still kills a genuinely stalled provider on the tight window', async () => {
    const source = createControllableSource<ToolPart>();
    let captured: StreamStalledError | undefined;
    const drain = (async () => {
      for await (const _part of withInactivityTimeout(source.iterate(), TOOL_WINDOWS, {
        describePart: (part) => part.type,
        toolExecutionPartKind,
      })) {
        // Drain until the tight window fires.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ type: 'text-delta' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(101);
    await settled;

    expect(captured?.phase).toBe('streaming');
    expect(captured?.inactivityMs).toBe(100);
  });

  it('does not go negative when settling an unknown id, and does not enter the phase', async () => {
    const source = createControllableSource<ToolPart>();
    let captured: StreamStalledError | undefined;
    const drain = (async () => {
      for await (const _part of withInactivityTimeout(source.iterate(), TOOL_WINDOWS, {
        describePart: (part) => part.type,
        toolExecutionPartKind,
      })) {
        // Drain until the tight window fires.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ id: 'zzz', type: 'tool-result' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(101);
    await settled;

    expect(captured?.phase).toBe('streaming');
  });

  it('clears in-flight calls when scaffolding opens a new step', async () => {
    // A new step means the previous step's tools are over: never inherit the
    // wide window into a fresh step just because a call was left dangling.
    const source = createControllableSource<ToolPart>();
    let captured: StreamStalledError | undefined;
    const drain = (async () => {
      for await (const _part of withInactivityTimeout(source.iterate(), TOOL_WINDOWS, {
        countsAsProviderOutput: (part) => part.type !== 'step-start',
        describePart: (part) => part.type,
        toolExecutionPartKind,
      })) {
        // Drain until the awaiting-output window fires.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ id: 'a', type: 'tool-call' });
    source.push({ type: 'step-start' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1001);
    await settled;

    expect(captured?.phase).toBe('awaiting-output');
  });

  it('keeps the tool-executing phase while output arrives during the call', async () => {
    const source = createControllableSource<ToolPart>();
    const seen: string[] = [];
    const drain = (async () => {
      for await (const part of withInactivityTimeout(source.iterate(), TOOL_WINDOWS, {
        describePart: (part) => part.type,
        toolExecutionPartKind,
      })) {
        seen.push(part.type);
      }
    })();

    source.push({ id: 'a', type: 'tool-call' });
    source.push({ type: 'tool-output' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4000);
    source.finish();
    await drain;

    expect(seen).toEqual(['tool-call', 'tool-output']);
  });

  it('reproduces three-phase behaviour when no classifier is supplied', async () => {
    const source = createControllableSource<ToolPart>();
    let captured: StreamStalledError | undefined;
    const drain = (async () => {
      for await (const _part of withInactivityTimeout(source.iterate(), TOOL_WINDOWS, {
        describePart: (part) => part.type,
      })) {
        // Drain until the tight window fires despite the "tool-call" name.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ id: 'a', type: 'tool-call' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(101);
    await settled;

    expect(captured?.phase).toBe('streaming');
  });
});

describe('withInactivityTimeout — seeded in-flight ids (resume leg, BST-1777 I1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  interface ToolPart {
    readonly id?: string;
    readonly type: string;
  }

  const toolExecutionPartKind = (part: ToolPart) => {
    if (part.type === 'tool-call') {
      return { kind: 'started' as const, toolCallId: part.id as string };
    }
    if (part.type === 'tool-result') {
      return { kind: 'settled' as const, toolCallId: part.id as string };
    }
    return;
  };

  const TOOL_WINDOWS = {
    firstOutputMs: 1000,
    interOutputMs: 100,
    reasoningGapMs: 1000,
    toolExecutingMs: 5000,
  } as const;

  it('a seeded id does not stall under a silence that would break the provider window', async () => {
    const source = createControllableSource<ToolPart>();
    const seen: string[] = [];
    const drain = (async () => {
      for await (const part of withInactivityTimeout(source.iterate(), TOOL_WINDOWS, {
        describePart: (part) => part.type,
        initialToolCallIds: ['seeded-a'],
        toolExecutionPartKind,
      })) {
        seen.push(part.type);
      }
    })();

    // 4000ms of total silence dwarfs interOutputMs (100) and firstOutputMs
    // (1000) alike — only the seeded tool-executing window (5000) survives it.
    await vi.advanceTimersByTimeAsync(4000);
    source.push({ id: 'seeded-a', type: 'tool-result' });
    await vi.advanceTimersByTimeAsync(0);
    source.finish();
    await drain;

    expect(seen).toEqual(['tool-result']);
  });

  it('the backstop still fires for a seeded id whose guard never answers, as tool-executing', async () => {
    const source = createControllableSource<ToolPart>();
    let captured: StreamStalledError | undefined;
    const drain = (async () => {
      for await (const _part of withInactivityTimeout(source.iterate(), TOOL_WINDOWS, {
        describePart: (part) => part.type,
        initialToolCallIds: ['seeded-a'],
        toolExecutionPartKind,
      })) {
        // Drain until the backstop fires.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    await vi.advanceTimersByTimeAsync(5001);
    await settled;

    expect(captured?.phase).toBe('tool-executing');
    expect(captured?.inactivityMs).toBe(TOOL_WINDOWS.toolExecutingMs);
  });

  it('returns to the provider phase once the seeded id settles', async () => {
    const source = createControllableSource<ToolPart>();
    let captured: StreamStalledError | undefined;
    const drain = (async () => {
      for await (const _part of withInactivityTimeout(source.iterate(), TOOL_WINDOWS, {
        describePart: (part) => part.type,
        initialToolCallIds: ['seeded-a'],
        toolExecutionPartKind,
      })) {
        // Drain until the tight window fires after the seeded id settles.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    source.push({ id: 'seeded-a', type: 'tool-result' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(101);
    await settled;

    expect(captured?.phase).toBe('streaming');
  });

  it('a seeded id survives leading framework scaffolding before its own settle', async () => {
    const source = createControllableSource<ToolPart>();
    const seen: string[] = [];
    const drain = (async () => {
      for await (const part of withInactivityTimeout(source.iterate(), TOOL_WINDOWS, {
        countsAsProviderOutput: (part) => part.type !== 'start' && part.type !== 'step-start',
        describePart: (part) => part.type,
        initialToolCallIds: ['seeded-a'],
        toolExecutionPartKind,
      })) {
        seen.push(part.type);
      }
    })();

    source.push({ type: 'start' });
    source.push({ type: 'step-start' });
    await vi.advanceTimersByTimeAsync(0);
    // Would already have tripped firstOutputMs (1000) if scaffolding had wiped
    // the seed; must survive on the seeded tool-executing window instead.
    await vi.advanceTimersByTimeAsync(4000);
    source.push({ id: 'seeded-a', type: 'tool-result' });
    await vi.advanceTimersByTimeAsync(0);
    source.finish();
    await drain;

    expect(seen).toEqual(['start', 'step-start', 'tool-result']);
  });

  it('absent initialToolCallIds reproduces unseeded behaviour', async () => {
    const source = createControllableSource<ToolPart>();
    let captured: StreamStalledError | undefined;
    const drain = (async () => {
      for await (const _part of withInactivityTimeout(source.iterate(), TOOL_WINDOWS, {
        describePart: (part) => part.type,
        toolExecutionPartKind,
      })) {
        // Drain until the awaiting-output window fires.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    await vi.advanceTimersByTimeAsync(1001);
    await settled;

    expect(captured?.phase).toBe('awaiting-output');
  });
});
