import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { type AgentColor, isAgentColor } from '@brainstrike/types/agent-color';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAssistantThreadHost } from './assistant-thread-host-context';
import type { DelegatedSidebarRow } from './delegated-sidebar-rows';
import {
  type HostChildSidebarSnapshot,
  HostChildSidebarStore,
  type HostChildTabSelection,
} from './host-child-sidebar-store';
import { hostChildWorkspaceTabId, readHostChildWorkspaceTab } from './host-child-workspace-tab';
import type { ThreadPanelVisibleRow } from './thread-panel-visible-rows';

interface ExpandedParent {
  readonly depth: number;
  readonly groupId: string | null;
  readonly threadId: string;
}

const EMPTY: HostChildSidebarSnapshot = { children: new Map(), unread: new Set() };
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/** A collapsed parent hides, and stops reading, every row beneath it. */
function collapseHostParent(
  expanded: ReadonlyMap<string, ExpandedParent>,
  rowId: string,
  store: HostChildSidebarStore,
  snapshot: HostChildSidebarSnapshot
): ReadonlyMap<string, ExpandedParent> {
  const next = new Map(expanded);
  const closing = [rowId];
  for (let id = closing.pop(); id !== undefined; id = closing.pop()) {
    const parent = next.get(id);
    next.delete(id);
    if (!parent) {
      continue;
    }
    store.collapse(parent.threadId);
    const children = snapshot.children.get(parent.threadId);
    for (const child of children instanceof Error ? [] : (children ?? [])) {
      closing.push(hostChildWorkspaceTabId(child));
    }
  }
  return next;
}

/** An expanded host thread or child reads its children from the host. */
function expandHostParent(
  expanded: ReadonlyMap<string, ExpandedParent>,
  row: Extract<ThreadPanelVisibleRow, { kind: 'thread' | 'host-child' }>,
  store: HostChildSidebarStore
): ReadonlyMap<string, ExpandedParent> {
  const threadId = row.kind === 'thread' ? row.id : row.child.threadId;
  const depth = row.kind === 'host-child' ? row.depth : row.parentId === null ? 0 : 1;
  store.expand(threadId);
  return new Map(expanded).set(row.id, { depth, groupId: row.groupId, threadId });
}

/** The child thread a selected workspace tab shows; a malformed address shows its own error. */
function selectedChildThread(): string | undefined {
  const { selection } = useWorkspaceTabSelectionStore.getState();
  if (selection.kind !== 'app') {
    return;
  }
  try {
    return readHostChildWorkspaceTab(selection.appId)?.threadId;
  } catch {
    return;
  }
}

const WORKSPACE_TAB_SELECTION: HostChildTabSelection = {
  current: selectedChildThread,
  subscribe: (listener) => useWorkspaceTabSelectionStore.subscribe(listener),
};

/**
 * BST-1932 (F19–F21): the threads panel's rows for agent host children. A
 * host thread expands to its children as the host lists them, with a status
 * the host derives and re-reads only when the host says it changed; a child's
 * row is unread until its tab is selected.
 */
export function useHostChildSidebar() {
  const host = useAssistantThreadHost();
  const store = useMemo(() => {
    const childThreads = host?.childThreads?.bind(host);
    const subscribeChildren = host?.subscribeChildren?.bind(host);
    return childThreads && subscribeChildren
      ? new HostChildSidebarStore({ childThreads, subscribeChildren }, WORKSPACE_TAB_SELECTION)
      : undefined;
  }, [host]);
  useEffect(() => () => store?.close(), [store]);
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIPTION,
    store?.getSnapshot ?? (() => EMPTY)
  );
  const [expanded, setExpanded] = useState<ReadonlyMap<string, ExpandedParent>>(() => new Map());
  const owns = useCallback(
    (row: ThreadPanelVisibleRow): boolean =>
      row.kind === 'host-child' || (row.kind === 'thread' && host?.isHostThread?.(row.id) === true),
    [host]
  );
  const toggle = useCallback(
    (row: ThreadPanelVisibleRow): void => {
      if (!(store && owns(row) && (row.kind === 'thread' || row.kind === 'host-child'))) {
        return;
      }
      setExpanded(
        expanded.has(row.id)
          ? collapseHostParent(expanded, row.id, store, snapshot)
          : expandHostParent(expanded, row, store)
      );
    },
    [expanded, owns, snapshot, store]
  );
  const project = useCallback(
    (base: readonly ThreadPanelVisibleRow[]): ThreadPanelVisibleRow[] => {
      const rows: ThreadPanelVisibleRow[] = [];
      const append = (parentId: string, parentColor: AgentColor | undefined): void => {
        const parent = expanded.get(parentId);
        if (!parent) {
          return;
        }
        const state = (label: string, isError = false): void => {
          rows.push({
            depth: parent.depth + 1,
            groupId: parent.groupId,
            id: `delegated-state:${parentId}`,
            isError,
            kind: 'delegated-state',
            label,
            parentId,
          });
        };
        const children = snapshot.children.get(parent.threadId);
        if (children === undefined) {
          state('Loading child conversations…');
          return;
        }
        if (children instanceof Error) {
          state(children.message, true);
          return;
        }
        if (children.length === 0) {
          state('No child conversations');
          return;
        }
        for (const child of children) {
          const id = hostChildWorkspaceTabId(child);
          const row: DelegatedSidebarRow = {
            child,
            depth: parent.depth + 1,
            groupId: parent.groupId,
            id,
            kind: 'host-child',
            parentColor,
            parentId,
            unread: snapshot.unread.has(child.threadId),
          };
          rows.push(row);
          append(id, isAgentColor(child.color) ? child.color : undefined);
        }
      };
      for (const row of base) {
        rows.push(row);
        if (row.kind === 'thread') {
          const color = row.thread.metadata?.color;
          append(row.id, isAgentColor(color) ? color : undefined);
        }
      }
      return rows;
    },
    [expanded, snapshot]
  );
  const expandedIds = useMemo(() => new Set(expanded.keys()), [expanded]);
  return { enabled: store !== undefined, expandedIds, owns, project, toggle };
}
