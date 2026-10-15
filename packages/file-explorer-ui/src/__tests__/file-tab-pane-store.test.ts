// @vitest-environment node
/**
 * Per-file explorer pane state (BST-1269). Session-only zustand store keyed by
 * compositeKey; durability comes from the per-thread workspace snapshot
 * (`editors[*].pane`), NOT from browser storage — hydratePanes replaces the
 * whole record on thread switch.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PANE_WIDTH_PCT, useFileTabPaneStore } from '../stores/file-tab-pane-store';

const KEY = 'root|@|src/index.ts';

describe('file-tab-pane-store', () => {
  beforeEach(() => {
    useFileTabPaneStore.getState().hydratePanes({});
  });

  it('absent state means OPEN (BST-1318): first toggle materializes an explicit close', () => {
    // The pane auto-opens with the file; a manual close must be RECORDED
    // (open: false) — deleting the entry instead would evaporate the user's
    // choice on the next snapshot hydrate.
    const store = useFileTabPaneStore.getState();
    store.togglePane(KEY);
    expect(useFileTabPaneStore.getState().panes[KEY]).toEqual({
      expandedPaths: [],
      open: false,
      widthPct: DEFAULT_PANE_WIDTH_PCT,
    });

    useFileTabPaneStore.getState().toggleExpandedPath(KEY, '/root/src');
    useFileTabPaneStore.getState().togglePane(KEY);
    expect(useFileTabPaneStore.getState().panes[KEY]).toEqual({
      expandedPaths: ['/root/src'],
      open: true,
      widthPct: DEFAULT_PANE_WIDTH_PCT,
    });
  });

  it('width/expansion writes on an absent key materialize an OPEN pane', () => {
    // Both actions are only reachable while the pane is visible, and absent
    // means open — recording open: false here would flip a visible pane shut
    // on the next hydrate.
    useFileTabPaneStore.getState().setPaneWidthPct(KEY, 42);
    expect(useFileTabPaneStore.getState().panes[KEY]?.open).toBe(true);

    useFileTabPaneStore.getState().hydratePanes({});
    useFileTabPaneStore.getState().toggleExpandedPath(KEY, '/root/src');
    expect(useFileTabPaneStore.getState().panes[KEY]?.open).toBe(true);
  });

  it('toggleExpandedPath adds and removes paths', () => {
    const store = useFileTabPaneStore.getState();
    store.toggleExpandedPath(KEY, '/root/src');
    store.toggleExpandedPath(KEY, '/root/src/components');
    expect(useFileTabPaneStore.getState().panes[KEY]?.expandedPaths).toEqual([
      '/root/src',
      '/root/src/components',
    ]);
    useFileTabPaneStore.getState().toggleExpandedPath(KEY, '/root/src');
    expect(useFileTabPaneStore.getState().panes[KEY]?.expandedPaths).toEqual([
      '/root/src/components',
    ]);
  });

  it('setPaneWidthPct clamps to the sane resize band', () => {
    const store = useFileTabPaneStore.getState();
    store.togglePane(KEY);
    useFileTabPaneStore.getState().setPaneWidthPct(KEY, 3);
    expect(useFileTabPaneStore.getState().panes[KEY]?.widthPct).toBe(10);
    useFileTabPaneStore.getState().setPaneWidthPct(KEY, 92);
    expect(useFileTabPaneStore.getState().panes[KEY]?.widthPct).toBe(70);
    useFileTabPaneStore.getState().setPaneWidthPct(KEY, 42);
    expect(useFileTabPaneStore.getState().panes[KEY]?.widthPct).toBe(42);
  });

  it('hydratePanes clamps widthPct to the same band as the write path', () => {
    useFileTabPaneStore.getState().hydratePanes({
      narrow: { expandedPaths: [], open: true, widthPct: 2 },
      wide: { expandedPaths: [], open: true, widthPct: 95 },
    });
    const panes = useFileTabPaneStore.getState().panes;
    expect(panes['wide']?.widthPct).toBe(70);
    expect(panes['narrow']?.widthPct).toBe(10);
  });

  it('hydratePanes replaces the whole record (thread switch)', () => {
    useFileTabPaneStore.getState().togglePane(KEY);
    useFileTabPaneStore.getState().hydratePanes({
      other: { expandedPaths: ['/x'], open: true, widthPct: 25 },
    });
    const panes = useFileTabPaneStore.getState().panes;
    expect(panes[KEY]).toBeUndefined();
    expect(panes['other']).toEqual({ expandedPaths: ['/x'], open: true, widthPct: 25 });
  });
});
