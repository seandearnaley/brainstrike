import { useEditorViewStateStore } from '@brainstrike/file-explorer-ui/editor-view-state-store';
import {
  DEFAULT_PANE_WIDTH_PCT,
  type FileTabPaneState,
  useFileTabPaneStore,
} from '@brainstrike/file-explorer-ui/file-tab-pane-store';
import type { useFileExplorerStoreContext } from '@brainstrike/file-explorer-ui/shell';
import { useTabManagerStore } from '@brainstrike/file-explorer-ui/tab-manager-store';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import type { WorkspaceStateFacade } from './workspace-snapshot-io';

type FileExplorerStoreLike = ReturnType<typeof useFileExplorerStoreContext>;

/**
 * Bind the pure snapshot IO facade to the LIVE stores (BST-1268). The three
 * flat singletons (selection, tab manager, editor view state) are imported by
 * dependency-light subpaths; the file-explorer store is per-provider and
 * injected. Hydration goes through each store's dedicated hydrate action —
 * hydration is an event, and stores are only ever written by events.
 */
export function createLiveWorkspaceFacade(
  fileExplorerStore: FileExplorerStoreLike
): WorkspaceStateFacade {
  return {
    applyApps: (openAppIds, selection) => {
      useWorkspaceTabSelectionStore.getState().hydrate(openAppIds, selection);
    },
    applyEditorState: (compositeKey, editor) => {
      const editorState = useEditorViewStateStore.getState();
      if (editor.mode) {
        editorState.setMode(compositeKey, editor.mode);
      }
      if (typeof editor.scrollTop === 'number') {
        editorState.setScrollTop(compositeKey, editor.scrollTop);
      }
    },
    applyExpandedPaths: (paths) => {
      fileExplorerStore.getState().setExpandedPaths(paths);
    },
    applyExplorerScrollTop: (scrollTop) => {
      fileExplorerStore.getState().setExplorerScrollTop(scrollTop ?? 0);
    },
    applyFileTabs: (tabs, activeTabId) => {
      useTabManagerStore.getState().hydrateTabs(tabs, activeTabId);
    },
    applyPanes: (panes) => {
      const hydrated: Record<string, FileTabPaneState> = {};
      for (const [compositeKey, pane] of Object.entries(panes)) {
        hydrated[compositeKey] = {
          expandedPaths: pane.expandedPaths ?? [],
          open: pane.open,
          widthPct: pane.widthPct ?? DEFAULT_PANE_WIDTH_PCT,
        };
      }
      useFileTabPaneStore.getState().hydratePanes(hydrated);
    },
    applyRootViews: (focusedRootId, visibleRootIds) => {
      const state = fileExplorerStore.getState();
      if (visibleRootIds !== null) {
        const descriptors = visibleRootIds
          .map((rootId) => state.rootDescriptors[rootId])
          .filter((descriptor): descriptor is NonNullable<typeof descriptor> =>
            Boolean(descriptor)
          );
        if (descriptors.length > 0) {
          state.setActiveRoots(descriptors);
        }
      }
      if (focusedRootId !== null && state.rootDescriptors[focusedRootId]) {
        state.setCurrentFolderId(focusedRootId);
      }
    },
    closeApps: (appIds) => {
      useWorkspaceTabSelectionStore.getState().closeApps(appIds);
    },
    getEditorState: (compositeKey) => {
      const editorState = useEditorViewStateStore.getState();
      const mode = editorState.modes[compositeKey];
      const scrollTop = editorState.scrollTops[compositeKey];
      const pane = useFileTabPaneStore.getState().panes[compositeKey];
      return {
        ...(mode ? { mode } : {}),
        ...(pane
          ? {
              pane: {
                expandedPaths: [...pane.expandedPaths],
                open: pane.open,
                widthPct: pane.widthPct,
              },
            }
          : {}),
        ...(typeof scrollTop === 'number' ? { scrollTop } : {}),
      };
    },
    getExpandedDirectoryPaths: () => fileExplorerStore.getState().expandedDirectoryPaths,
    getExplorerScrollTop: () => {
      const value = fileExplorerStore.getState().explorerScrollTop;
      return value > 0 ? value : undefined;
    },
    getFileTabs: () => {
      const state = useTabManagerStore.getState();
      return {
        activeTabId: state.activeTabId,
        tabs: state.tabs.map((tab) => ({ compositeKey: tab.compositeKey, path: tab.path })),
      };
    },
    getFocusedRootId: () => fileExplorerStore.getState().currentFolderId ?? null,
    getOpenAppIds: () => useWorkspaceTabSelectionStore.getState().openAppIds,
    getRootDescriptors: () => fileExplorerStore.getState().rootDescriptors,
    getSelection: () => useWorkspaceTabSelectionStore.getState().selection,
    getVisibleRootIds: () => {
      const ids = fileExplorerStore.getState().activeRootIds;
      return ids.length > 0 ? [...ids] : null;
    },
  };
}
