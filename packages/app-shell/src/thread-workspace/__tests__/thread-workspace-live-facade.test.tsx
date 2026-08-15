/**
 * Live facade ↔ pane store binding (BST-1269). The pane store is session-only;
 * per-thread durability rides `editors[*].pane`, so the live facade must
 * capture pane state per open tab and hydrate the record WHOLESALE on thread
 * switch (leftover panes from the previous thread must vanish).
 */

import { useFileTabPaneStore } from '@brainstrike/file-explorer-ui/file-tab-pane-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveWorkspaceFacade } from '../thread-workspace-coordinator';

type FileExplorerStoreLike = Parameters<typeof createLiveWorkspaceFacade>[0];

function createFakeFileExplorerStore(): FileExplorerStoreLike {
  const state = {
    activeRootIds: [] as string[],
    currentFolderId: null,
    expandedDirectoryPaths: new Set<string>(),
    explorerScrollTop: 0,
    rootDescriptors: {},
    setActiveRoots: vi.fn(),
    setCurrentFolderId: vi.fn(),
    setExpandedPaths: vi.fn(),
    setExplorerScrollTop: vi.fn(),
  };
  return {
    getState: () => state,
    subscribe: vi.fn(() => () => undefined),
  } as unknown as FileExplorerStoreLike;
}

describe('createLiveWorkspaceFacade pane binding', () => {
  beforeEach(() => {
    useFileTabPaneStore.getState().hydratePanes({});
  });

  it('getEditorState includes the tab pane state when one exists', () => {
    useFileTabPaneStore.getState().hydratePanes({
      k1: { expandedPaths: ['/r/src'], open: true, widthPct: 25 },
    });
    const facade = createLiveWorkspaceFacade(createFakeFileExplorerStore());

    expect(facade.getEditorState('k1').pane).toEqual({
      expandedPaths: ['/r/src'],
      open: true,
      widthPct: 25,
    });
    expect(facade.getEditorState('k2').pane).toBeUndefined();
  });

  it('applyPanes replaces the pane record wholesale', () => {
    useFileTabPaneStore.getState().hydratePanes({
      stale: { expandedPaths: [], open: true, widthPct: 30 },
    });
    const facade = createLiveWorkspaceFacade(createFakeFileExplorerStore());

    facade.applyPanes({ k1: { expandedPaths: ['/x'], open: true, widthPct: 40 } });

    const panes = useFileTabPaneStore.getState().panes;
    expect(panes['stale']).toBeUndefined();
    expect(panes['k1']).toEqual({ expandedPaths: ['/x'], open: true, widthPct: 40 });
  });

  it('applyPanes fills omitted optional fields with store defaults', () => {
    const facade = createLiveWorkspaceFacade(createFakeFileExplorerStore());

    facade.applyPanes({ k1: { open: true } });

    expect(useFileTabPaneStore.getState().panes['k1']).toEqual({
      expandedPaths: [],
      open: true,
      widthPct: 30,
    });
  });
});
