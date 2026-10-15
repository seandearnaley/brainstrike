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
  readonly threadId: string;
}

const EMPTY: HostChildSidebarSnapshot = { children: new Map(), unread: new Set() };
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/** A collapsed parent hides its descendants; its own child discovery stays observed. */
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
  store.expand(threadId);
  return new Map(expanded).set(row.id, { threadId });
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

/**
 * The panel's rows with each expanded host parent's children (or its loading,
 * error or empty state) beneath it, recursively.
 */
function projectHostChildRows(
  base: readonly ThreadPanelVisibleRow[],
  expanded: ReadonlyMap<string, ExpandedParent>,
  snapshot: HostChildSidebarSnapshot,
  retry: (threadId: string) => void
): ThreadPanelVisibleRow[] {
  const rows: ThreadPanelVisibleRow[] = [];
  const append = (
    parent: Extract<ThreadPanelVisibleRow, { kind: 'thread' | 'host-child' }>,
    parentColor: AgentColor | undefined,
    root: Extract<DelegatedSidebarRow, { kind: 'host-child' }>['root']
  ): void => {
    const threadId = parent.kind === 'thread' ? parent.id : parent.child.threadId;
    const depth = parent.kind === 'host-child' ? parent.depth : parent.parentId === null ? 0 : 1;
    const children = snapshot.children.get(threadId);
    const state = (label: string, isError = false): void => {
      rows.push({
        depth: depth + 1,
        groupId: parent.groupId,
        id: `delegated-state:${parent.id}`,
        isError,
        kind: 'delegated-state',
        label,
        onRetry: isError ? () => retry(threadId) : undefined,
        parentId: parent.id,
      });
    };
    if (children instanceof Error) {
      state(children.message, true);
      return;
    }
    if (!expanded.has(parent.id)) {
      return;
    }
    if (children === undefined) {
      state('Loading child conversations…');
      return;
    }
    for (const child of children) {
      const row: Extract<DelegatedSidebarRow, { kind: 'host-child' }> = {
        child,
        depth: depth + 1,
        groupId: parent.groupId,
        id: hostChildWorkspaceTabId(child),
        kind: 'host-child',
        parentColor,
        parentId: parent.id,
        root,
        unread: snapshot.unread.has(child.threadId),
      };
      rows.push(row);
      append(row, isAgentColor(child.color) ? child.color : undefined, root);
    }
  };
  for (const row of base) {
    rows.push(row);
    if (row.kind === 'thread') {
      const color = row.thread.metadata?.color;
      append(row, isAgentColor(color) ? color : undefined, {
        resourceId: row.thread.resourceId,
        threadId: row.thread.id,
      });
    }
  }
  return rows;
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
export function useHostChildSidebar(base: readonly ThreadPanelVisibleRow[]) {
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
  const retry = useCallback((threadId: string) => store?.retry(threadId), [store]);
  const rows = useMemo(
    () => projectHostChildRows(base, expanded, snapshot, retry),
    [base, expanded, snapshot, retry]
  );
  useEffect(() => {
    store?.observe(
      rows.flatMap((row) => {
        if (!owns(row)) {
          return [];
        }
        return row.kind === 'host-child' ? [row.child.threadId] : [row.id];
      })
    );
  }, [owns, rows, store]);
  const hasChildren = useCallback(
    (row: ThreadPanelVisibleRow): boolean => {
      if (!owns(row)) {
        return false;
      }
      const threadId = row.kind === 'host-child' ? row.child.threadId : row.id;
      const children = snapshot.children.get(threadId);
      return Array.isArray(children) && children.length > 0;
    },
    [owns, snapshot]
  );
  const expandedIds = useMemo(() => new Set(expanded.keys()), [expanded]);
  return { expandedIds, hasChildren, owns, rows, toggle };
}
