import type {
  AssistantMemoryThread,
  AssistantThreadRunRecord,
  AssistantThreadRunStatus,
} from '@brainstrike/assistant-data';
import { resetAssistantThreadStore, useAssistantThreadStore } from '@brainstrike/assistant-data';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveUnseenThreadIds,
  useMarkOnScreenThreadViewed,
  useUnseenThreadIds,
} from '../hooks/use-unseen-thread-ids';

const RESOURCE_ID = 'resource-1';

function run(status: AssistantThreadRunStatus, completedAt: Date | null): AssistantThreadRunRecord {
  return {
    completedAt,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    error: null,
    id: `run-${status}-${completedAt?.toISOString() ?? 'null'}`,
    model: 'model',
    provider: 'provider',
    resourceId: RESOURCE_ID,
    runtimeKind: 'hosted',
    startedAt: new Date('2026-08-01T00:00:00.000Z'),
    status,
    threadId: 'thread',
    turnMessageId: null,
    updatedAt: completedAt ?? new Date('2026-08-01T00:00:00.000Z'),
  };
}

function thread(id: string, latestRun?: AssistantThreadRunRecord): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    id,
    resourceId: RESOURCE_ID,
    title: id,
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...(latestRun ? { latestRun } : {}),
  };
}

const AT_100 = new Date(100);
const AT_200 = new Date(200);

beforeEach(() => {
  resetAssistantThreadStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deriveUnseenThreadIds', () => {
  it('marks a terminal run that completed after the thread watermark as unseen', () => {
    const result = deriveUnseenThreadIds({
      lastViewedAtByThreadId: { 'thread-a': 100 },
      onScreenThreadId: null,
      threads: [thread('thread-a', run('completed', AT_200))],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen]).toEqual(['thread-a']);
    expect([...result.failedUnseen]).toEqual([]);
  });

  it('treats a thread with no watermark as never viewed', () => {
    const result = deriveUnseenThreadIds({
      lastViewedAtByThreadId: {},
      onScreenThreadId: null,
      threads: [thread('thread-a', run('completed', new Date(1)))],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen]).toEqual(['thread-a']);
  });

  it('excludes a run that completed at or before the watermark', () => {
    const result = deriveUnseenThreadIds({
      lastViewedAtByThreadId: { 'thread-a': 200, 'thread-b': 300 },
      onScreenThreadId: null,
      threads: [
        thread('thread-a', run('completed', AT_200)),
        thread('thread-b', run('failed', AT_200)),
      ],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen]).toEqual([]);
  });

  it('excludes the on-screen thread even when its run completed after the watermark', () => {
    const result = deriveUnseenThreadIds({
      lastViewedAtByThreadId: {},
      onScreenThreadId: 'thread-a',
      threads: [
        thread('thread-a', run('completed', AT_200)),
        thread('thread-b', run('failed', AT_200)),
      ],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen]).toEqual(['thread-b']);
  });

  // BST-1845: the thread the user last had OPEN is not the thread they are
  // LOOKING at. With Settings showing, or the window in the background, nothing
  // is on screen, so a run that finishes on that thread is news.
  it('reports every thread, the one last open included, when nothing is on screen', () => {
    const result = deriveUnseenThreadIds({
      lastViewedAtByThreadId: {},
      onScreenThreadId: null,
      threads: [
        thread('thread-a', run('completed', AT_200)),
        thread('thread-b', run('failed', AT_200)),
      ],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen].sort()).toEqual(['thread-a', 'thread-b']);
    expect([...result.failedUnseen]).toEqual(['thread-b']);
  });

  it('excludes a still-running thread and a thread with no run at all', () => {
    const result = deriveUnseenThreadIds({
      lastViewedAtByThreadId: {},
      onScreenThreadId: null,
      threads: [thread('thread-a', run('running', null)), thread('thread-b')],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen]).toEqual([]);
  });

  // NO SILENT FALLBACK: a terminal run with no completion timestamp cannot be
  // compared against the watermark. It is excluded, never substituted with
  // `startedAt` or `Date.now()`.
  it('excludes a terminal run that carries no completion timestamp', () => {
    const result = deriveUnseenThreadIds({
      lastViewedAtByThreadId: {},
      onScreenThreadId: null,
      threads: [thread('thread-a', run('cancelled', null))],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen]).toEqual([]);
  });

  it('reports failed unseen threads as a subset of unseen', () => {
    const result = deriveUnseenThreadIds({
      lastViewedAtByThreadId: { 'thread-d': 100 },
      onScreenThreadId: null,
      threads: [
        thread('thread-a', run('completed', AT_200)),
        thread('thread-b', run('failed', AT_200)),
        thread('thread-c', run('cancelled', AT_200)),
        // Failed, but already seen — must not leak into `failedUnseen`.
        thread('thread-d', run('failed', AT_100)),
      ],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen].sort()).toEqual(['thread-a', 'thread-b', 'thread-c']);
    expect([...result.failedUnseen]).toEqual(['thread-b']);
    for (const id of result.failedUnseen) {
      expect(result.unseen.has(id)).toBe(true);
    }
  });

  // The fresh-install / post-upgrade storm. With no watermark at all, an
  // unfloored derivation calls EVERY thread that ever finished a run unseen —
  // a column of dots on precisely the signal that means "this finished while
  // you were away".
  it('excludes a completed run below the baseline when the thread has no watermark', () => {
    const result = deriveUnseenThreadIds({
      lastViewedAtByThreadId: {},
      onScreenThreadId: null,
      threads: [thread('thread-a', run('completed', AT_100))],
      unseenBaselineAt: 150,
    });

    expect([...result.unseen]).toEqual([]);
    expect([...result.failedUnseen]).toEqual([]);
  });

  it('marks a run that completed after the baseline unseen without any watermark', () => {
    const result = deriveUnseenThreadIds({
      lastViewedAtByThreadId: {},
      onScreenThreadId: null,
      threads: [thread('thread-a', run('failed', AT_200))],
      unseenBaselineAt: 150,
    });

    expect([...result.unseen]).toEqual(['thread-a']);
    expect([...result.failedUnseen]).toEqual(['thread-a']);
  });

  // The baseline is a FLOOR, not a replacement: a per-thread watermark that is
  // later than it still decides, so opening a thread keeps clearing its dot.
  it('lets a later per-thread watermark outrank the baseline', () => {
    const result = deriveUnseenThreadIds({
      lastViewedAtByThreadId: { 'thread-a': 250 },
      onScreenThreadId: null,
      threads: [thread('thread-a', run('completed', AT_200))],
      unseenBaselineAt: 100,
    });

    expect([...result.unseen]).toEqual([]);
  });

  it('counts a cancelled run as unseen', () => {
    const result = deriveUnseenThreadIds({
      lastViewedAtByThreadId: {},
      onScreenThreadId: null,
      threads: [thread('thread-a', run('cancelled', AT_200))],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen]).toEqual(['thread-a']);
    expect([...result.failedUnseen]).toEqual([]);
  });
});

describe('useUnseenThreadIds', () => {
  it('returns a stable projection across renders with equal inputs', () => {
    const threads = [thread('thread-a', run('failed', AT_200))];
    const lastViewedAtByThreadId = {};
    const { rerender, result } = renderHook(() =>
      useUnseenThreadIds({
        lastViewedAtByThreadId,
        onScreenThreadId: null,
        threads,
        unseenBaselineAt: 0,
      })
    );
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
    expect([...result.current.failedUnseen]).toEqual(['thread-a']);
  });
});

// BST-1845. "Seen" is a statement about the SCREEN: this hook stamps a thread
// only when the surface that renders transcripts says it is on screen (the
// caller has already folded in route, visibility and window focus), and it
// stamps the run's own `completedAt`, never the renderer's clock.
describe('useMarkOnScreenThreadViewed', () => {
  const watermarks = (): Record<string, number> =>
    useAssistantThreadStore.getState().lastViewedAtByThreadId;

  function renderStamper(initial: {
    readonly onScreenThreadId: string | null;
    readonly threads: readonly AssistantMemoryThread[];
  }) {
    return renderHook(
      (props: {
        readonly onScreenThreadId: string | null;
        readonly threads: readonly AssistantMemoryThread[];
      }) => {
        useMarkOnScreenThreadViewed(props);
      },
      { initialProps: initial }
    );
  }

  it('stamps the run completion time, not the renderer clock, when a thread comes on screen', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(9000));

    renderStamper({
      onScreenThreadId: 'thread-a',
      threads: [thread('thread-a', run('completed', AT_200))],
    });

    expect(watermarks()['thread-a']).toBe(200);
  });

  it('stamps nothing while nothing is on screen', () => {
    renderStamper({
      onScreenThreadId: null,
      threads: [thread('thread-a', run('completed', AT_200))],
    });

    expect(watermarks()).toEqual({});
  });

  // A watermark is only ever compared with a `completedAt`, so a thread with no
  // terminal completion has nothing to stamp. Inventing `Date.now()` here is
  // what let a still-loading thread list read as "seen".
  it.each([
    ['no run at all', thread('thread-a')],
    ['a run that is still going', thread('thread-a', run('running', null))],
    ['a terminal run with no completion time', thread('thread-a', run('failed', null))],
    // Only a TERMINAL run's completion is comparable with the watermark.
    ['a non-terminal run', thread('thread-a', run('running', AT_100))],
  ])('stamps nothing for %s', (_label, subject) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(9000));

    renderStamper({ onScreenThreadId: 'thread-a', threads: [subject] });

    expect(watermarks()).toEqual({});
  });

  it('stamps nothing while the thread list is still loading, then the completion once it lands', () => {
    const { rerender } = renderStamper({ onScreenThreadId: 'thread-a', threads: [] });
    expect(watermarks()).toEqual({});

    rerender({
      onScreenThreadId: 'thread-a',
      threads: [thread('thread-a', run('completed', AT_200))],
    });

    expect(watermarks()['thread-a']).toBe(200);
  });

  // The foreground finish: it must never read as unseen afterwards.
  it('stamps a run that completes while its thread is on screen', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(9000));
    const { rerender } = renderStamper({
      onScreenThreadId: 'thread-a',
      threads: [thread('thread-a', run('running', null))],
    });
    const completed = [thread('thread-a', run('completed', new Date(2500)))];

    rerender({ onScreenThreadId: 'thread-a', threads: completed });

    expect(watermarks()['thread-a']).toBe(2500);
    expect(
      deriveUnseenThreadIds({
        lastViewedAtByThreadId: watermarks(),
        onScreenThreadId: null,
        threads: completed,
        unseenBaselineAt: 0,
      }).unseen.size
    ).toBe(0);
  });

  // The bug: a completion that arrives while the thread is NOT on screen
  // (Settings route, hidden or blurred window) was stamped as viewed.
  it('does not stamp a run that completes while its thread is off screen', () => {
    const { rerender } = renderStamper({
      onScreenThreadId: null,
      threads: [thread('thread-a', run('running', null))],
    });
    const completed = [thread('thread-a', run('completed', AT_200))];

    rerender({ onScreenThreadId: null, threads: completed });

    expect(watermarks()).toEqual({});
    expect(
      deriveUnseenThreadIds({
        lastViewedAtByThreadId: watermarks(),
        onScreenThreadId: null,
        threads: completed,
        unseenBaselineAt: 0,
      }).unseen.has('thread-a')
    ).toBe(true);
  });

  it('stamps the completion once the thread returns to screen', () => {
    const completed = [thread('thread-a', run('completed', AT_200))];
    const { rerender } = renderStamper({ onScreenThreadId: null, threads: completed });
    expect(watermarks()).toEqual({});

    rerender({ onScreenThreadId: 'thread-a', threads: completed });

    expect(watermarks()['thread-a']).toBe(200);
  });

  // Leaving used to stamp too, marking a run seen that finished off screen and
  // was never shown.
  it('does not stamp a thread when it leaves the screen, whatever finished since', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(9000));
    const { rerender, unmount } = renderStamper({
      onScreenThreadId: 'thread-a',
      threads: [thread('thread-a', run('completed', AT_100))],
    });
    expect(watermarks()).toEqual({ 'thread-a': 100 });

    rerender({
      onScreenThreadId: null,
      threads: [thread('thread-a', run('completed', AT_200))],
    });
    unmount();

    expect(watermarks()).toEqual({ 'thread-a': 100 });
  });

  it('stamps only the incoming thread on a switch, never the outgoing one', () => {
    const threads = [
      thread('thread-a', run('completed', AT_100)),
      thread('thread-b', run('completed', AT_200)),
    ];
    const { rerender } = renderStamper({ onScreenThreadId: 'thread-a', threads });
    useAssistantThreadStore.setState({ lastViewedAtByThreadId: {} });

    rerender({ onScreenThreadId: 'thread-b', threads });

    expect(watermarks()).toEqual({ 'thread-b': 200 });
  });

  // Continuous stamping would defeat a manual "mark unread" (Codex #13115):
  // the stamp is an EVENT of coming on screen or of a new completion.
  it('stamps on transitions only, not on every render', () => {
    const markThreadViewed = vi.fn();
    useAssistantThreadStore.setState({ markThreadViewed });
    const { rerender } = renderStamper({
      onScreenThreadId: 'thread-a',
      threads: [thread('thread-a', run('completed', AT_200))],
    });
    expect(markThreadViewed).toHaveBeenCalledTimes(1);

    // A refreshed list carries new thread objects with the same completion.
    rerender({
      onScreenThreadId: 'thread-a',
      threads: [thread('thread-a', run('completed', AT_200))],
    });
    rerender({
      onScreenThreadId: 'thread-a',
      threads: [thread('thread-a', run('completed', AT_200))],
    });

    expect(markThreadViewed).toHaveBeenCalledTimes(1);
  });
});
