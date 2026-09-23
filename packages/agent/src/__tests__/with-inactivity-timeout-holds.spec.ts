/**
 * `routePart` + `heldWork`: one watchdog over a stream that background work
 * holds open (a background leg's parent while its children run). The stream
 * judges only its OWN producer; held work is judged by its own watchdog while
 * that watch runs, and otherwise bounded at the first-output window.
 * The Mastra router and the production part shapes are pinned by
 * `../mastra/__tests__/mastra-background-watchdog-holds.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type HeldWorkWatch,
  type StreamInactivityOptions,
  StreamStalledError,
  withInactivityTimeout,
} from '../stream/with-inactivity-timeout';

interface HoldPart {
  readonly id?: string;
  readonly task?: string;
  readonly type: string;
}

const WINDOWS = {
  firstOutputMs: 5000,
  interOutputMs: 1000,
  reasoningGapMs: 5000,
  toolExecutingMs: 9000,
} as const;

/** A controllable stand-in for the per-child watchdogs' `watching()` state. */
function createWatch(initial: boolean): HeldWorkWatch & {
  /** Listeners subscribed and not yet released. */
  live(): number;
  set(watching: boolean): void;
} {
  let watching = initial;
  const listeners = new Set<() => void>();
  return {
    live: () => listeners.size,
    set(next) {
      watching = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe(listener) {
      const own = () => listener();
      listeners.add(own);
      return () => {
        listeners.delete(own);
      };
    },
    watching: (held) => watching && held.size > 0,
  };
}

function options(heldWork?: HeldWorkWatch): StreamInactivityOptions<HoldPart> {
  return {
    countsAsProviderOutput: (part) => part.type !== 'step-start',
    describePart: (part) => part.type,
    ...(heldWork ? { heldWork } : {}),
    routePart: (part) => {
      if (part.type === 'note' || part.type === 'child-output') {
        return { kind: 'bookkeeping' };
      }
      if (part.type === 'hold') {
        return { holds: part.task ?? '', kind: 'bookkeeping' };
      }
      if (part.type === 'release') {
        return { kind: 'bookkeeping', releases: part.task ?? '' };
      }
      return { kind: 'produced', part };
    },
    toolExecutionPartKind: (part) =>
      part.id && (part.type === 'tool-call' || part.type === 'tool-result')
        ? { kind: part.type === 'tool-call' ? 'started' : 'settled', toolCallId: part.id }
        : undefined,
  };
}

/** Yields `parts` at the given offsets (ms), then stays silent. */
async function* timeline(
  steps: readonly (readonly [number, HoldPart])[]
): AsyncIterableIterator<HoldPart> {
  for (const [delayMs, part] of steps) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield part;
  }
  await new Promise<never>(() => {
    // Silence: the watchdog settles the case.
  });
}

function watchStream(
  steps: readonly (readonly [number, HoldPart])[],
  heldWork?: HeldWorkWatch
): { readonly drained: Promise<void>; readonly stall: () => StreamStalledError | undefined } {
  let captured: StreamStalledError | undefined;
  const drained = (async () => {
    for await (const _part of withInactivityTimeout(timeline(steps), WINDOWS, options(heldWork))) {
      // Drain until a window fires.
    }
  })().catch((error: unknown) => {
    if (!(error instanceof StreamStalledError)) {
      throw error;
    }
    captured = error;
  });
  return { drained, stall: () => captured };
}

describe('withInactivityTimeout — background work that holds the stream open', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bookkeeping re-arms the timer but moves no phase', async () => {
    const watched = watchStream([
      [0, { type: 'step-start' }],
      [4000, { type: 'note' }],
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    await watched.drained;
    // Still the producer's first-output wait (not `streaming`), measured from the note.
    expect(watched.stall()).toMatchObject({
      inactivityMs: 5000,
      lastPartType: 'note',
      partsSeen: 2,
      phase: 'awaiting-output',
    });
  });

  it('judges nothing while held work is watched by its own watchdog, however long it takes', async () => {
    const watched = watchStream(
      [
        [0, { type: 'text' }],
        [0, { task: 't1', type: 'hold' }],
      ],
      createWatch(true)
    );
    await vi.advanceTimersByTimeAsync(10 * WINDOWS.toolExecutingMs);
    expect(watched.stall()).toBeUndefined();
  });

  it("applies the producer's own window again once the held work is released", async () => {
    const watched = watchStream(
      [
        [0, { type: 'text' }],
        [0, { task: 't1', type: 'hold' }],
        [30_000, { task: 't1', type: 'release' }],
      ],
      createWatch(true)
    );
    await vi.advanceTimersByTimeAsync(30_000 + WINDOWS.interOutputMs + 1);
    await watched.drained;
    expect(watched.stall()).toMatchObject({
      inactivityMs: WINDOWS.interOutputMs,
      lastPartType: 'release',
      phase: 'streaming',
    });
  });

  it('bounds held work nothing watches at the first-output window', async () => {
    const watched = watchStream(
      [
        [0, { type: 'text' }],
        [0, { task: 't1', type: 'hold' }],
      ],
      createWatch(false)
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs - 500);
    expect(watched.stall()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    await watched.drained;
    expect(watched.stall()).toMatchObject({
      inactivityMs: WINDOWS.firstOutputMs,
      phase: 'awaiting-output',
    });
  });

  it('a stream with no watch at all bounds its held work the same way', async () => {
    const watched = watchStream([
      [0, { type: 'text' }],
      [0, { task: 't1', type: 'hold' }],
    ]);
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs + 100);
    await watched.drained;
    expect(watched.stall()).toMatchObject({
      inactivityMs: WINDOWS.firstOutputMs,
      phase: 'awaiting-output',
    });
  });

  it('re-judges the wait the moment the watch ends, without waiting for a part', async () => {
    const watch = createWatch(true);
    const watched = watchStream(
      [
        [0, { type: 'text' }],
        [0, { task: 't1', type: 'hold' }],
      ],
      watch
    );
    await vi.advanceTimersByTimeAsync(40_000);
    watch.set(false);
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs - 1);
    expect(watched.stall()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await watched.drained;
    expect(watched.stall()).toMatchObject({
      inactivityMs: WINDOWS.firstOutputMs,
      phase: 'awaiting-output',
    });
  });

  it('holds at most one change listener however many parts arrive while held', async () => {
    const watch = createWatch(true);
    const parts: (readonly [number, HoldPart])[] = [
      [0, { type: 'text' }],
      [0, { task: 't1', type: 'hold' }],
      ...Array.from({ length: 50 }, () => [10, { type: 'child-output' }] as const),
    ];
    const live: number[] = [];
    const drained = (async () => {
      for await (const _part of withInactivityTimeout(timeline(parts), WINDOWS, options(watch))) {
        live.push(watch.live());
      }
    })().catch(() => {
      // The verdict is not under test here.
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(live).toHaveLength(52);
    expect(Math.max(...live)).toBeLessThanOrEqual(1);
    watch.set(false);
    await vi.advanceTimersByTimeAsync(WINDOWS.firstOutputMs);
    await drained;
    // The ended stream keeps no listener.
    expect(watch.live()).toBe(0);
  });

  it('ignores the watch while nothing holds the stream open', async () => {
    const watched = watchStream([[0, { type: 'text' }]], createWatch(true));
    await vi.advanceTimersByTimeAsync(WINDOWS.interOutputMs);
    await watched.drained;
    expect(watched.stall()).toMatchObject({
      inactivityMs: WINDOWS.interOutputMs,
      phase: 'streaming',
    });
  });

  it("held work's output never clears the producer's own running call", async () => {
    const watched = watchStream(
      [
        [0, { type: 'text' }],
        [0, { id: 'root-call', type: 'tool-call' }],
        [0, { task: 't1', type: 'hold' }],
        [0, { type: 'child-output' }],
        [0, { task: 't1', type: 'release' }],
      ],
      createWatch(true)
    );
    await vi.advanceTimersByTimeAsync(WINDOWS.toolExecutingMs + 100);
    await watched.drained;
    expect(watched.stall()).toMatchObject({
      inactivityMs: WINDOWS.toolExecutingMs,
      phase: 'tool-executing',
    });
  });

  it("the producer's running call still reports tool-executing while unwatched work is held", async () => {
    // A misconfigured first-output window wider than the tool backstop must
    // never let a running call's stall read as a retryable provider one.
    const wideFirstOutput = { ...WINDOWS, firstOutputMs: 20_000, reasoningGapMs: 20_000 };
    let captured: StreamStalledError | undefined;
    const drained = (async () => {
      for await (const _part of withInactivityTimeout(
        timeline([
          [0, { type: 'text' }],
          [0, { id: 'root-call', type: 'tool-call' }],
          [0, { task: 't1', type: 'hold' }],
        ]),
        wideFirstOutput,
        options(createWatch(false))
      )) {
        // Drain.
      }
    })().catch((error: unknown) => {
      captured = error as StreamStalledError;
    });
    await vi.advanceTimersByTimeAsync(20_000 + 100);
    await drained;
    expect(captured).toMatchObject({ inactivityMs: 20_000, phase: 'tool-executing' });
  });
});
