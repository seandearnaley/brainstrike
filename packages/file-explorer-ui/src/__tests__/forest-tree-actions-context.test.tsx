import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ExpandAllProgress,
  ForestTreeActionsProvider,
  type ForestTreeActionsValue,
  useForestExpandAllProgress,
  useForestIsExpandingAll,
  useOptionalForestTreeActions,
} from '../shell/forest-tree-actions-context';

// Deterministic rAF: the provider coalesces progress notifications through
// requestAnimationFrame, so tests queue callbacks and flush them explicitly.
let rafQueue: FrameRequestCallback[] = [];

beforeEach(() => {
  rafQueue = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    rafQueue.push(callback);
    return rafQueue.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function flushProgressFrames() {
  act(() => {
    const pending = rafQueue;
    rafQueue = [];
    for (const callback of pending) {
      callback(0);
    }
  });
}

function setup() {
  const actionsRef: { current: ForestTreeActionsValue | null } = { current: null };
  const progressRef: { current: ExpandAllProgress | null } = { current: null };
  const isExpandingRef: { current: boolean } = { current: false };
  const renderCounts = { actions: 0, progress: 0 };

  function ActionsProbe() {
    renderCounts.actions += 1;
    actionsRef.current = useOptionalForestTreeActions();
    return null;
  }
  function ProgressProbe() {
    renderCounts.progress += 1;
    progressRef.current = useForestExpandAllProgress();
    isExpandingRef.current = useForestIsExpandingAll();
    return null;
  }

  render(
    <ForestTreeActionsProvider>
      <ActionsProbe />
      <ProgressProbe />
    </ForestTreeActionsProvider>
  );
  return { actionsRef, isExpandingRef, progressRef, renderCounts };
}

const sectionStub = (expandAll: () => Promise<void>) => ({
  cancelExpandAll: vi.fn(),
  expandAll,
  getVisibleQuickFilterKeys: () => [],
  selectAll: vi.fn().mockResolvedValue({ limitReached: false, selected: 0 }),
});

describe('ForestTreeActionsProvider expand-all progress aggregation', () => {
  it('aggregates per-section progress reported during a run', async () => {
    const { actionsRef, progressRef } = setup();
    act(() => {
      actionsRef.current?.register(
        'root-a',
        sectionStub(async () => {
          actionsRef.current?.reportExpandAllProgress('root-a', { loaded: 2, total: 5 });
        })
      );
      actionsRef.current?.register(
        'root-b',
        sectionStub(async () => {
          actionsRef.current?.reportExpandAllProgress('root-b', { loaded: 1, total: 4 });
        })
      );
    });

    await act(async () => {
      await actionsRef.current?.runExpandAll();
    });
    flushProgressFrames();

    // The toolbar reads one aggregate count: the sum over every section that
    // reported during this run (sections run sequentially; completed sections
    // keep their final values).
    expect(progressRef.current).toEqual({ loaded: 3, total: 9 });
  });

  it('replaces a section’s previous report instead of double-counting it', async () => {
    const { actionsRef, progressRef } = setup();
    act(() => {
      actionsRef.current?.register(
        'root-a',
        sectionStub(async () => {
          // Monotonic per-section progress: later reports REPLACE earlier ones
          // (delta aggregation), they do not accumulate on top of them.
          actionsRef.current?.reportExpandAllProgress('root-a', { loaded: 2, total: 5 });
          actionsRef.current?.reportExpandAllProgress('root-a', { loaded: 4, total: 6 });
        })
      );
      actionsRef.current?.register(
        'root-b',
        sectionStub(async () => {
          actionsRef.current?.reportExpandAllProgress('root-b', { loaded: 1, total: 1 });
        })
      );
    });

    await act(async () => {
      await actionsRef.current?.runExpandAll();
    });
    flushProgressFrames();

    expect(progressRef.current).toEqual({ loaded: 5, total: 7 });
  });

  it('resets the aggregate when a new run starts — no stale mixing across runs', async () => {
    const { actionsRef, progressRef } = setup();

    act(() => {
      actionsRef.current?.register(
        'root-a',
        sectionStub(async () => {
          actionsRef.current?.reportExpandAllProgress('root-a', { loaded: 7, total: 7 });
        })
      );
      actionsRef.current?.register(
        'root-b',
        sectionStub(async () => {
          actionsRef.current?.reportExpandAllProgress('root-b', { loaded: 3, total: 3 });
        })
      );
    });
    await act(async () => {
      await actionsRef.current?.runExpandAll();
    });
    flushProgressFrames();
    expect(progressRef.current).toEqual({ loaded: 10, total: 10 });

    // Second run: only root-b reports. The aggregate must be EXACTLY root-b's
    // numbers — root-a's counts from the previous run must not leak in.
    act(() => {
      actionsRef.current?.register(
        'root-a',
        sectionStub(async () => {})
      );
      actionsRef.current?.register(
        'root-b',
        sectionStub(async () => {
          actionsRef.current?.reportExpandAllProgress('root-b', { loaded: 1, total: 2 });
        })
      );
    });
    await act(async () => {
      await actionsRef.current?.runExpandAll();
    });
    flushProgressFrames();

    expect(progressRef.current).toEqual({ loaded: 1, total: 2 });
  });

  it('clears the previous run’s aggregate at run start and reports isExpandingAll mid-run', async () => {
    const { actionsRef, isExpandingRef, progressRef } = setup();
    act(() => {
      actionsRef.current?.reportExpandAllProgress('root-a', { loaded: 9, total: 9 });
    });
    flushProgressFrames();
    expect(progressRef.current).toEqual({ loaded: 9, total: 9 });

    // Gate the section so the run stays in flight while we assert.
    let releaseSection = () => {};
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    act(() => {
      actionsRef.current?.register(
        'root-a',
        sectionStub(() => sectionGate)
      );
    });

    let runPromise: Promise<void> | undefined;
    act(() => {
      runPromise = actionsRef.current?.runExpandAll();
    });

    // The stale 9/9 from the previous run must never be visible once the new
    // run has begun — the reset must not wait for an animation frame — and
    // the run state must read as expanding while the section is in flight.
    expect(progressRef.current).toBeNull();
    expect(isExpandingRef.current).toBe(true);

    releaseSection();
    await act(async () => {
      await runPromise;
    });
    expect(isExpandingRef.current).toBe(false);
  });

  it('keeps the same aggregate object when a report does not change the sums', () => {
    const { actionsRef, progressRef, renderCounts } = setup();

    act(() => {
      actionsRef.current?.reportExpandAllProgress('root-a', { loaded: 2, total: 5 });
    });
    flushProgressFrames();
    const first = progressRef.current;
    expect(first).toEqual({ loaded: 2, total: 5 });
    const progressRendersAfterFirst = renderCounts.progress;

    // Value-equal bailout: identical sums must not mint a new object or
    // re-notify subscribers.
    act(() => {
      actionsRef.current?.reportExpandAllProgress('root-a', { loaded: 2, total: 5 });
    });
    flushProgressFrames();
    expect(progressRef.current).toBe(first);
    expect(renderCounts.progress).toBe(progressRendersAfterFirst);
  });

  it('coalesces a burst of reports into one notification per animation frame', () => {
    const { actionsRef, progressRef, renderCounts } = setup();
    const progressRendersBefore = renderCounts.progress;

    act(() => {
      actionsRef.current?.reportExpandAllProgress('root-a', { loaded: 1, total: 10 });
      actionsRef.current?.reportExpandAllProgress('root-a', { loaded: 2, total: 10 });
      actionsRef.current?.reportExpandAllProgress('root-b', { loaded: 5, total: 10 });
    });
    // Nothing is published until the frame flushes.
    expect(progressRef.current).toBeNull();

    flushProgressFrames();
    expect(progressRef.current).toEqual({ loaded: 7, total: 20 });
    // One frame → exactly one subscriber notification for the whole burst.
    expect(renderCounts.progress).toBe(progressRendersBefore + 1);
  });

  it('accepts trailing reports after a run (commits can lag) — display stays gated on isExpandingAll', async () => {
    const { actionsRef, isExpandingRef, progressRef } = setup();

    act(() => {
      actionsRef.current?.register(
        'root-a',
        sectionStub(async () => {})
      );
    });
    await act(async () => {
      await actionsRef.current?.runExpandAll();
    });

    // A section's final progress commit can land AFTER runExpandAll resolves
    // (React batches under load). The report must still be recorded — the
    // toolbar only shows it while isExpandingAll, and the next run clears it.
    act(() => {
      actionsRef.current?.reportExpandAllProgress('root-a', { loaded: 4, total: 4 });
    });
    flushProgressFrames();

    expect(progressRef.current).toEqual({ loaded: 4, total: 4 });
    expect(isExpandingRef.current).toBe(false);
  });
});

describe('ForestTreeActionsProvider context split (stable actions vs observable progress)', () => {
  it('keeps the actions value identity stable across progress reports', () => {
    const { actionsRef, renderCounts } = setup();
    const initialActions = actionsRef.current;
    const actionsRendersBefore = renderCounts.actions;

    act(() => {
      actionsRef.current?.reportExpandAllProgress('root-a', { loaded: 1, total: 8 });
      actionsRef.current?.reportExpandAllProgress('root-b', { loaded: 2, total: 8 });
    });
    flushProgressFrames();
    act(() => {
      actionsRef.current?.reportExpandAllProgress('root-a', { loaded: 5, total: 8 });
    });
    flushProgressFrames();

    // Progress events must not re-render actions-only consumers (every
    // PerRootTreePane subscribes to the actions context) nor churn the
    // registry callbacks' identities.
    expect(renderCounts.actions).toBe(actionsRendersBefore);
    expect(actionsRef.current).toBe(initialActions);
  });

  it('does not re-render actions-only consumers across a full run lifecycle', async () => {
    const { actionsRef, renderCounts } = setup();
    act(() => {
      actionsRef.current?.register(
        'root-a',
        sectionStub(async () => {
          actionsRef.current?.reportExpandAllProgress('root-a', { loaded: 3, total: 3 });
        })
      );
    });
    const initialActions = actionsRef.current;
    const actionsRendersBefore = renderCounts.actions;

    await act(async () => {
      await actionsRef.current?.runExpandAll();
    });
    flushProgressFrames();

    // Run start/end flips isExpandingAll — that lives in the OBSERVABLE
    // context, so actions consumers stay untouched.
    expect(renderCounts.actions).toBe(actionsRendersBefore);
    expect(actionsRef.current).toBe(initialActions);
  });

  it('returns null progress and false isExpandingAll outside a provider', () => {
    const probe: {
      actions: ForestTreeActionsValue | null;
      isExpanding: boolean | null;
      progress: ExpandAllProgress | null;
    } = { actions: null, isExpanding: null, progress: null };
    function BareProbe() {
      probe.actions = useOptionalForestTreeActions();
      probe.progress = useForestExpandAllProgress();
      probe.isExpanding = useForestIsExpandingAll();
      return null;
    }
    render(<BareProbe />);
    expect(probe.actions).toBeNull();
    expect(probe.progress).toBeNull();
    expect(probe.isExpanding).toBe(false);
  });
});
