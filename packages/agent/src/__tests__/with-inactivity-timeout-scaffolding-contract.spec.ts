/**
 * The one contract behind the watchdog's in-flight CLEAR (BST-1777 PR review,
 * Claude #1).
 *
 * `withInactivityTimeout` clears its in-flight tool calls whenever the last
 * part did not count as provider output. That is only correct because
 * `countsAsProviderOutput` means FRAMEWORK STEP SCAFFOLDING — so a caller that
 * wrongly excludes a part which can arrive BETWEEN a `tool-call` and its
 * `tool-result` (`tool-output`, a progress chunk) drops its own running tool
 * back onto the provider's silence window, mid-execution.
 *
 * Pinned here rather than in the main spec purely to keep that file under the
 * per-file line cap. Mastra's own closed, typed scaffolding list was pinned by
 * `../mastra/__tests__/mastra-tool-execution-part-kind.spec.ts` (removed with
 * ADR-0022).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamStalledError, withInactivityTimeout } from '../stream/with-inactivity-timeout';

interface ToolPart {
  readonly id?: string;
  readonly type: string;
}

const TOOL_WINDOWS = {
  firstOutputMs: 1000,
  interOutputMs: 100,
  reasoningGapMs: 2000,
  toolExecutingMs: 5000,
} as const;

/** A source that yields the queued parts and then blocks forever. */
async function* neverEnding(parts: readonly ToolPart[]): AsyncIterableIterator<ToolPart> {
  for (const part of parts) {
    yield part;
  }
  await new Promise<never>(() => {
    // Silence from here: the watchdog's window is what settles this test.
  });
}

describe('withInactivityTimeout — the scaffolding clear is the ONLY clear', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a part the caller does not count as provider output CLEARS an in-flight call', async () => {
    let captured: StreamStalledError | undefined;
    const drain = (async () => {
      for await (const _part of withInactivityTimeout(
        neverEnding([{ id: 'a', type: 'tool-call' }, { type: 'tool-output' }]),
        TOOL_WINDOWS,
        {
          countsAsProviderOutput: (part) => part.type !== 'tool-output',
          describePart: (part) => part.type,
          toolExecutionPartKind: (part) =>
            part.type === 'tool-call' && part.id
              ? ({ kind: 'started', toolCallId: part.id } as const)
              : undefined,
        }
      )) {
        // Drain until a window fires.
      }
    })();
    const settled = expect(drain).rejects.toBeInstanceOf(StreamStalledError);
    drain.catch((error: unknown) => {
      captured = error as StreamStalledError;
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1001);
    await settled;

    // Back on the PROVIDER's first-output window (1000ms), not the 5000ms
    // tool-executing backstop the call was holding a moment earlier.
    expect(captured?.phase).toBe('awaiting-output');
    expect(captured?.inactivityMs).toBe(1000);
  });
});
