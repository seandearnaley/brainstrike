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
  useMarkActiveThreadViewed,
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
      activeThreadId: null,
      lastViewedAtByThreadId: { 'thread-a': 100 },
      threads: [thread('thread-a', run('completed', AT_200))],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen]).toEqual(['thread-a']);
    expect([...result.failedUnseen]).toEqual([]);
  });

  it('treats a thread with no watermark as never viewed', () => {
    const result = deriveUnseenThreadIds({
      activeThreadId: null,
      lastViewedAtByThreadId: {},
      threads: [thread('thread-a', run('completed', new Date(1)))],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen]).toEqual(['thread-a']);
  });

  it('excludes a run that completed at or before the watermark', () => {
    const result = deriveUnseenThreadIds({
      activeThreadId: null,
      lastViewedAtByThreadId: { 'thread-a': 200, 'thread-b': 300 },
      threads: [
        thread('thread-a', run('completed', AT_200)),
        thread('thread-b', run('failed', AT_200)),
      ],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen]).toEqual([]);
  });

  it('excludes the active thread even when its run completed after the watermark', () => {
    const result = deriveUnseenThreadIds({
      activeThreadId: 'thread-a',
      lastViewedAtByThreadId: {},
      threads: [
        thread('thread-a', run('completed', AT_200)),
        thread('thread-b', run('failed', AT_200)),
      ],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen]).toEqual(['thread-b']);
  });

  it('excludes a still-running thread and a thread with no run at all', () => {
    const result = deriveUnseenThreadIds({
      activeThreadId: null,
      lastViewedAtByThreadId: {},
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
      activeThreadId: null,
      lastViewedAtByThreadId: {},
      threads: [thread('thread-a', run('cancelled', null))],
      unseenBaselineAt: 0,
    });

    expect([...result.unseen]).toEqual([]);
  });

  it('reports failed unseen threads as a subset of unseen', () => {
    const result = deriveUnseenThreadIds({
      activeThreadId: null,
      lastViewedAtByThreadId: { 'thread-d': 100 },
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
      activeThreadId: null,
      lastViewedAtByThreadId: {},
      threads: [thread('thread-a', run('completed', AT_100))],
      unseenBaselineAt: 150,
    });

    expect([...result.unseen]).toEqual([]);
    expect([...result.failedUnseen]).toEqual([]);
  });

  it('marks a run that completed after the baseline unseen without any watermark', () => {
    const result = deriveUnseenThreadIds({
      activeThreadId: null,
      lastViewedAtByThreadId: {},
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
      activeThreadId: null,
      lastViewedAtByThreadId: { 'thread-a': 250 },
      threads: [thread('thread-a', run('completed', AT_200))],
      unseenBaselineAt: 100,
    });

    expect([...result.unseen]).toEqual([]);
  });

  it('counts a cancelled run as unseen', () => {
    const result = deriveUnseenThreadIds({
      activeThreadId: null,
      lastViewedAtByThreadId: {},
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
        activeThreadId: null,
        lastViewedAtByThreadId,
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

describe('useMarkActiveThreadViewed', () => {
  it('marks the newly active thread viewed on mount', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));

    renderHook(() =>
      useMarkActiveThreadViewed({ activeThreadId: 'thread-a', threads: [thread('thread-a')] })
    );

    expect(useAssistantThreadStore.getState().lastViewedAtByThreadId['thread-a']).toBe(1000);
  });

  it('marks both the outgoing and the incoming thread viewed on a switch', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));
    const threads = [thread('thread-a'), thread('thread-b')];
    const { rerender } = renderHook(
      (activeThreadId: string) => {
        useMarkActiveThreadViewed({ activeThreadId, threads });
      },
      { initialProps: 'thread-a' }
    );

    vi.setSystemTime(new Date(2000));
    rerender('thread-b');

    const watermarks = useAssistantThreadStore.getState().lastViewedAtByThreadId;
    expect(watermarks['thread-a']).toBe(2000);
    expect(watermarks['thread-b']).toBe(2000);
  });

  // The whole point of the hook: a run that finishes while its thread is the
  // ACTIVE one must never later read as unseen.
  it('re-marks the active thread when its latest run completes in the foreground', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000));
    const { rerender } = renderHook(
      (threads: readonly AssistantMemoryThread[]) => {
        useMarkActiveThreadViewed({ activeThreadId: 'thread-a', threads });
      },
      {
        initialProps: [
          thread('thread-a', run('running', null)),
        ] as readonly AssistantMemoryThread[],
      }
    );

    vi.setSystemTime(new Date(3000));
    const completed = [thread('thread-a', run('completed', new Date(2500)))];
    rerender(completed);

    expect(useAssistantThreadStore.getState().lastViewedAtByThreadId['thread-a']).toBe(3000);
    expect(
      deriveUnseenThreadIds({
        activeThreadId: null,
        lastViewedAtByThreadId: useAssistantThreadStore.getState().lastViewedAtByThreadId,
        threads: completed,
        unseenBaselineAt: 0,
      }).unseen.size
    ).toBe(0);
  });

  it('does nothing when there is no active thread', () => {
    renderHook(() => useMarkActiveThreadViewed({ activeThreadId: null, threads: [] }));

    expect(useAssistantThreadStore.getState().lastViewedAtByThreadId).toEqual({});
  });
});
