import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ForestTreeActionsProvider,
  type ForestTreeActionsValue,
  useOptionalForestTreeActions,
} from '../shell/forest-tree-actions-context';

function setup() {
  const ref: { current: ForestTreeActionsValue | null } = { current: null };
  function Probe() {
    ref.current = useOptionalForestTreeActions();
    return null;
  }
  render(
    <ForestTreeActionsProvider>
      <Probe />
    </ForestTreeActionsProvider>
  );
  return ref;
}

const sectionStub = (expandAll: () => Promise<void>) => ({
  cancelExpandAll: vi.fn(),
  expandAll,
  getVisibleQuickFilterKeys: () => [],
  selectAll: vi.fn().mockResolvedValue({ limitReached: false, selected: 0 }),
});

describe('ForestTreeActionsProvider expand-all progress aggregation', () => {
  it('aggregates per-section progress reported during a run', async () => {
    const ref = setup();
    act(() => {
      ref.current?.register(
        'root-a',
        sectionStub(async () => {
          ref.current?.reportExpandAllProgress('root-a', { loaded: 2, total: 5 });
        })
      );
      ref.current?.register(
        'root-b',
        sectionStub(async () => {
          ref.current?.reportExpandAllProgress('root-b', { loaded: 1, total: 4 });
        })
      );
    });

    await act(async () => {
      await ref.current?.runExpandAll();
    });

    // The toolbar reads one aggregate count: the sum over every section that
    // reported during this run (sections run sequentially; completed sections
    // keep their final values).
    expect(ref.current?.expandAllProgress).toEqual({ loaded: 3, total: 9 });
  });

  it('resets the aggregate when a new run starts — no stale mixing across runs', async () => {
    const ref = setup();

    act(() => {
      ref.current?.register(
        'root-a',
        sectionStub(async () => {
          ref.current?.reportExpandAllProgress('root-a', { loaded: 7, total: 7 });
        })
      );
      ref.current?.register(
        'root-b',
        sectionStub(async () => {
          ref.current?.reportExpandAllProgress('root-b', { loaded: 3, total: 3 });
        })
      );
    });
    await act(async () => {
      await ref.current?.runExpandAll();
    });
    expect(ref.current?.expandAllProgress).toEqual({ loaded: 10, total: 10 });

    // Second run: only root-b reports. The aggregate must be EXACTLY root-b's
    // numbers — root-a's counts from the previous run must not leak in.
    act(() => {
      ref.current?.register(
        'root-a',
        sectionStub(async () => {})
      );
      ref.current?.register(
        'root-b',
        sectionStub(async () => {
          ref.current?.reportExpandAllProgress('root-b', { loaded: 1, total: 2 });
        })
      );
    });
    await act(async () => {
      await ref.current?.runExpandAll();
    });

    expect(ref.current?.expandAllProgress).toEqual({ loaded: 1, total: 2 });
  });

  it('accepts trailing reports after a run (commits can lag) — display stays gated on isExpandingAll', async () => {
    const ref = setup();

    act(() => {
      ref.current?.register(
        'root-a',
        sectionStub(async () => {})
      );
    });
    await act(async () => {
      await ref.current?.runExpandAll();
    });

    // A section's final progress commit can land AFTER runExpandAll resolves
    // (React batches under load). The report must still be recorded — the
    // toolbar only shows it while isExpandingAll, and the next run clears it.
    act(() => {
      ref.current?.reportExpandAllProgress('root-a', { loaded: 4, total: 4 });
    });

    expect(ref.current?.expandAllProgress).toEqual({ loaded: 4, total: 4 });
    expect(ref.current?.isExpandingAll).toBe(false);
  });
});
