import type { AgentColor } from '@brainstrike/types/agent-color';
import type { ChildNode } from './delegated-workspace-node';
import { delegatedWorkspaceTabId } from './delegated-workspace-tab';
import type { ThreadPanelVisibleRow } from './thread-panel-visible-rows';

export interface DelegatedSidebarAddress {
  readonly depth: number;
  readonly groupId: string | null;
  readonly id: string;
  readonly ownerResourceId: string;
  readonly parentThreadId: string | null;
  readonly rootThreadId: string;
  readonly threadId: string;
}
export type DelegatedSidebarEntry =
  | { readonly children: readonly ChildNode[]; readonly pendingThreadIds?: ReadonlySet<string> }
  | { readonly error: Error };
export type DelegatedSidebarRow = {
  readonly id: string;
  readonly parentId: string;
  readonly depth: number;
  readonly groupId: string | null;
} & (
  | {
      readonly kind: 'delegated';
      readonly node: ChildNode;
      readonly needsInput?: boolean;
      readonly parentColor?: AgentColor | undefined;
    }
  | {
      readonly kind: 'delegated-state';
      readonly label: string;
      readonly isError: boolean;
      readonly moreFor?: string;
    }
);
export const DELEGATED_SIDEBAR_PAGE_SIZE = 50;

/** Extend the existing virtual tree; child ids never enter ordinary thread selection. */
export function projectDelegatedSidebarRows(
  base: readonly ThreadPanelVisibleRow[],
  expanded: ReadonlyMap<string, DelegatedSidebarAddress>,
  entries: ReadonlyMap<string, DelegatedSidebarEntry>,
  limits: ReadonlyMap<string, number>
): ThreadPanelVisibleRow[] {
  const rows: ThreadPanelVisibleRow[] = [];
  const colorByRowId = new Map<string, AgentColor>();
  const appendChildren = (parentId: string, ancestors: ReadonlySet<string>): void => {
    const parent = expanded.get(parentId);
    if (!parent) {
      return;
    }
    const entry = entries.get(parentId);
    const state = (label: string, isError = false, moreFor?: string) =>
      rows.push({
        depth: parent.depth + 1,
        groupId: parent.groupId,
        id: `delegated-state:${parentId}`,
        isError,
        kind: 'delegated-state',
        label,
        parentId,
        ...(moreFor ? { moreFor } : {}),
      });
    if (!entry) {
      state('Loading child conversations…');
      return;
    }
    if ('error' in entry) {
      state(entry.error.message, true);
      return;
    }
    if (entry.children.length === 0) {
      state('No child conversations');
      return;
    }
    const limit = limits.get(parentId) ?? DELEGATED_SIDEBAR_PAGE_SIZE;
    for (const node of entry.children.slice(0, limit)) {
      const id = delegatedWorkspaceTabId(node);
      const parentColor = colorByRowId.get(parentId);
      if (ancestors.has(node.threadId)) {
        state('Conflicting conversation ancestry', true);
        return;
      }
      rows.push({
        depth: parent.depth + 1,
        groupId: parent.groupId,
        id,
        kind: 'delegated',
        ...(entry.pendingThreadIds?.has(node.threadId) ? { needsInput: true } : {}),
        node,
        parentColor,
        parentId,
      });
      colorByRowId.set(id, node.color);
      appendChildren(id, new Set([...ancestors, node.threadId]));
    }
    if (entry.children.length > limit) {
      state(
        `Show ${Math.min(DELEGATED_SIDEBAR_PAGE_SIZE, entry.children.length - limit)} more child conversations`,
        false,
        parentId
      );
    }
  };
  for (const row of base) {
    rows.push(row);
    if (row.kind === 'thread') {
      if (row.thread.metadata?.color) {
        colorByRowId.set(row.id, row.thread.metadata.color);
      }
      appendChildren(row.id, new Set([row.id]));
    }
  }
  return rows;
}
