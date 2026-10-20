import type { ThreadWorkspaceRepository, WorkspaceSnapshotV1 } from '@brainstrike/assistant-data';
import { vi } from 'vitest';
import { ThreadWorkspaceNavigation } from '../../thread-workspace-navigation';
import type { WorkspaceStateFacade } from '../../workspace-snapshot-io';

/**
 * A minimal in-memory "live store": one mutable state bag the facade reads
 * and writes, plus a subscriber list the coordinator's aggregated
 * subscription taps.
 */
export function createHarness() {
  const listeners = new Set<() => void>();
  const state = {
    activeTabId: null as string | null,
    editorState: {} as WorkspaceSnapshotV1['editors'][string],
    expandedPaths: new Set<string>(),
    explorerScrollTop: undefined as number | undefined,
    focusedRootId: null as string | null,
    openAppIds: ['context-explorer'] as readonly string[],
    selection: { appId: 'context-explorer', kind: 'app' } as const as
      | { kind: 'app'; appId: string }
      | { kind: 'file'; tabId: string }
      | { kind: 'empty' },
    tabs: [] as Array<{ compositeKey: string; path: string }>,
    visibleRootIds: null as readonly string[] | null,
  };
  const applied: string[] = [];
  const facade: WorkspaceStateFacade = {
    applyApps: vi.fn((openAppIds, selection) => {
      state.openAppIds = openAppIds;
      state.selection = selection;
      applied.push('apps');
    }),
    applyEditorState: vi.fn((_compositeKey, editor) => {
      state.editorState = editor;
    }),
    applyExpandedPaths: vi.fn((paths) => {
      state.expandedPaths = paths;
    }),
    applyExplorerScrollTop: vi.fn((scrollTop) => {
      state.explorerScrollTop = scrollTop;
    }),
    applyFileTabs: vi.fn((tabs, activeTabId) => {
      state.tabs = [...tabs];
      state.activeTabId = activeTabId;
      applied.push('fileTabs');
    }),
    applyPanes: vi.fn(),
    applyRootViews: vi.fn((focusedRootId, visibleRootIds) => {
      state.focusedRootId = focusedRootId;
      state.visibleRootIds = visibleRootIds;
    }),
    // Mirrors the selection store: a closed selected app hands selection on.
    closeApps: vi.fn((appIds: readonly string[]) => {
      const closing = new Set(appIds);
      state.openAppIds = state.openAppIds.filter((id) => !closing.has(id));
      if (state.selection.kind === 'app' && closing.has(state.selection.appId)) {
        const successor = state.openAppIds.at(-1);
        state.selection = successor ? { appId: successor, kind: 'app' } : { kind: 'empty' };
      }
    }),
    getEditorState: vi.fn(() => state.editorState),
    getExpandedDirectoryPaths: vi.fn(() => state.expandedPaths),
    getExplorerScrollTop: vi.fn(() => state.explorerScrollTop),
    getFileTabs: vi.fn(() => ({ activeTabId: state.activeTabId, tabs: state.tabs })),
    getFocusedRootId: vi.fn(() => state.focusedRootId),
    getOpenAppIds: vi.fn(() => state.openAppIds),
    getRootDescriptors: vi.fn(() => ({})),
    getSelection: vi.fn(() => state.selection),
    getVisibleRootIds: vi.fn(() => state.visibleRootIds),
  };
  const rows = new Map<string, WorkspaceSnapshotV1>();
  const repository: ThreadWorkspaceRepository = {
    getThreadWorkspace: vi.fn(async (threadId: string) => rows.get(threadId) ?? null),
    getThreadWorkspaces: vi.fn(async (threadIds: readonly string[]) => {
      const map = new Map<string, WorkspaceSnapshotV1>();
      for (const id of threadIds) {
        const row = rows.get(id);
        if (row) {
          map.set(id, row);
        }
      }
      return map;
    }),
    setThreadWorkspace: vi.fn(async (threadId: string, _resourceId, snapshot) => {
      rows.set(threadId, snapshot);
    }),
  };
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const navigation = new ThreadWorkspaceNavigation({
    activateThread: vi.fn(),
    openApp: (appId) => {
      state.openAppIds = [...state.openAppIds, appId];
      state.selection = { appId, kind: 'app' };
      notify();
    },
    reportError: vi.fn(),
  });
  return { applied, facade, navigation, notify, repository, rows, state, subscribe };
}
