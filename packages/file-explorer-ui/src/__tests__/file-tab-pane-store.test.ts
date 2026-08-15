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

  it('togglePane opens with defaults and closes preserving expansions', () => {
    const store = useFileTabPaneStore.getState();
    store.togglePane(KEY);
    expect(useFileTabPaneStore.getState().panes[KEY]).toEqual({
      expandedPaths: [],
      open: true,
      widthPct: DEFAULT_PANE_WIDTH_PCT,
    });

    useFileTabPaneStore.getState().toggleExpandedPath(KEY, '/root/src');
    useFileTabPaneStore.getState().togglePane(KEY);
    expect(useFileTabPaneStore.getState().panes[KEY]).toEqual({
      expandedPaths: ['/root/src'],
      open: false,
      widthPct: DEFAULT_PANE_WIDTH_PCT,
    });
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
