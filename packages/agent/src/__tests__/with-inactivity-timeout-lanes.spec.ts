/**
 * `routePart`: one watchdog over a stream several producers write into (a
 * background leg's parent plus its running children). Each producer keeps its
 * own phase and running calls; the stream waits on the widest open lane.
 * The Mastra router and the production part shapes are pinned by
 * `../mastra/__tests__/mastra-background-watchdog-lanes.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type StreamInactivityOptions,
  StreamStalledError,
  withInactivityTimeout,
} from '../stream/with-inactivity-timeout';

interface LanePart {
  readonly id?: string;
  readonly lane?: string;
  readonly type: string;
}

const OPTIONS: StreamInactivityOptions<LanePart> = {
  countsAsProviderOutput: (part) => part.type !== 'step-start',
  describePart: (part) => part.type,
  routePart: (part) => {
    if (part.type === 'note') {
      return { kind: 'bookkeeping' };
    }
    if (part.type === 'open' || part.type === 'close') {
      return part.type === 'open'
        ? { kind: 'bookkeeping', opens: part.lane ?? '' }
        : { closes: part.lane ?? '', kind: 'bookkeeping' };
    }
    return part.lane === undefined
      ? { kind: 'produced', part }
      : { kind: 'produced', lane: part.lane, part };
  },
  toolExecutionPartKind: (part) =>
    part.id && (part.type === 'tool-call' || part.type === 'tool-result')
      ? { kind: part.type === 'tool-call' ? 'started' : 'settled', toolCallId: part.id }
      : undefined,
};

/** Yields `parts` at the given offsets (ms), then stays silent. */
async function* timeline(
  steps: readonly (readonly [number, LanePart])[]
): AsyncIterableIterator<LanePart> {
  for (const [delayMs, part] of steps) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield part;
  }
  await new Promise<never>(() => {
    // Silence: the watchdog settles the case.
  });
}

async function stallOf(
  steps: readonly (readonly [number, LanePart])[],
  windows: Parameters<typeof withInactivityTimeout>[1]
): Promise<StreamStalledError> {
  let captured: StreamStalledError | undefined;
  const drain = (async () => {
    for await (const _part of withInactivityTimeout(timeline(steps), windows, OPTIONS)) {
      // Drain until a window fires.
    }
  })().catch((error: unknown) => {
    captured = error as StreamStalledError;
  });
  await vi.advanceTimersByTimeAsync(60_000);
  await drain;
  if (!(captured instanceof StreamStalledError)) {
    throw new Error('Expected the watchdog to fire.');
  }
  return captured;
}

describe('withInactivityTimeout — producer lanes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a call running in ANY lane reports tool-executing, even when a provider lane is wider', async () => {
    // A misconfigured first-output window wider than the tool backstop must
    // still never let a running call's stall read as a retryable provider one.
    const windows = {
      firstOutputMs: 20_000,
      interOutputMs: 1000,
      reasoningGapMs: 20_000,
      toolExecutingMs: 9000,
    };
    const stall = await stallOf(
      [
        [0, { type: 'step-start' }],
        [0, { id: 'child-call', lane: 'child', type: 'tool-call' }],
      ],
      windows
    );
    expect(stall).toMatchObject({ inactivityMs: 20_000, phase: 'tool-executing' });
  });

  it('bookkeeping re-arms the timer but moves no phase', async () => {
    const windows = {
      firstOutputMs: 5000,
      interOutputMs: 1000,
      reasoningGapMs: 5000,
      toolExecutingMs: 9000,
    };
    const stall = await stallOf(
      [
        [0, { type: 'step-start' }],
        [4000, { type: 'note' }],
      ],
      windows
    );
    // Still the provider's first-output wait (not `streaming`), measured from the note.
    expect(stall).toMatchObject({
      inactivityMs: 5000,
      lastPartType: 'note',
      partsSeen: 2,
      phase: 'awaiting-output',
    });
  });

  it("one lane's new step clears only its own running calls", async () => {
    const windows = {
      firstOutputMs: 5000,
      interOutputMs: 1000,
      reasoningGapMs: 5000,
      toolExecutingMs: 9000,
    };
    const stall = await stallOf(
      [
        [0, { type: 'text' }],
        [0, { id: 'root-call', type: 'tool-call' }],
        [0, { lane: 'child', type: 'text' }],
        [0, { lane: 'child', type: 'step-start' }],
        [0, { lane: 'child', type: 'close' }],
      ],
      windows
    );
    expect(stall).toMatchObject({ inactivityMs: 9000, phase: 'tool-executing' });
  });
});
