import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { createDelegatedConversationRepository } from '@brainstrike/db';
import { type DbHandle, usePGliteDatabase } from '@brainstrike/db/react';
import { use, useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react';
import {
  DELEGATED_SIDEBAR_PAGE_SIZE,
  type DelegatedSidebarAddress,
  type DelegatedSidebarEntry,
  projectDelegatedSidebarRows,
} from './delegated-sidebar-rows';
import type { ChildNode } from './delegated-workspace-node';
import type { ThreadPanelVisibleRow } from './thread-panel-visible-rows';
import { RootsContext } from './use-delegated-conversation-root';

interface CachedEntry {
  readonly db: DbHandle;
  readonly signature: string;
  readonly value: DelegatedSidebarEntry;
}
async function loadChildren(
  db: DbHandle,
  parent: DelegatedSidebarAddress
): Promise<readonly ChildNode[]> {
  const nodes = await createDelegatedConversationRepository(db).listChildren(
    parent,
    parent.threadId
  );
  return nodes.map((node) => {
    if (
      !(
        node.ownerResourceId === parent.ownerResourceId &&
        node.rootThreadId === parent.rootThreadId &&
        node.parentThreadId === parent.threadId &&
        node.displayName &&
        node.color
      )
    ) {
      throw new Error('Child conversations conflict with their owning parent.');
    }
    return { ...node, color: node.color, displayName: node.displayName };
  });
}

export function useDelegatedSidebar(baseRows: readonly ThreadPanelVisibleRow[]) {
  const db = usePGliteDatabase();
  const roots = use(RootsContext);
  const [expanded, setExpanded] = useState<ReadonlyMap<string, DelegatedSidebarAddress>>(
    () => new Map()
  );
  const [entries, setEntries] = useState<ReadonlyMap<string, CachedEntry>>(() => new Map());
  const [limits, setLimits] = useState<ReadonlyMap<string, number>>(() => new Map());
  const activeExpanded = useMemo(() => {
    const visibleRoots = new Set(
      baseRows.flatMap((row) => (row.kind === 'thread' ? [row.id] : []))
    );
    return new Map([...expanded].filter(([, address]) => visibleRoots.has(address.rootThreadId)));
  }, [baseRows, expanded]);
  const readEntry = useEffectEvent((id: string) => entries.get(id));
  useEffect(() => {
    if (!(db && roots)) {
      return;
    }
    const cleanups: Array<() => void> = [];
    for (const parent of activeExpanded.values()) {
      let active = true;
      let sequence = 0;
      let observedSignature: string | undefined;
      const release = roots.subscribe(parent, () => undefined);
      const root = roots.get(parent);
      if (!root) {
        throw new Error('The expanded conversation has no root registry.');
      }
      const refresh = () => {
        const signature = JSON.stringify([...root.store.getSnapshot().keys()]);
        if (observedSignature === signature) {
          return;
        }
        observedSignature = signature;
        if (readEntry(parent.id)?.db === db && readEntry(parent.id)?.signature === signature) {
          return;
        }
        const request = ++sequence;
        const publish = (value: DelegatedSidebarEntry) => {
          if (active && sequence === request) {
            setEntries((current) => new Map(current).set(parent.id, { db, signature, value }));
          }
        };
        loadChildren(db, parent).then(
          (children) => publish({ children }),
          (error: unknown) =>
            publish({ error: error instanceof Error ? error : new Error(String(error)) })
        );
      };
      refresh();
      const unsubscribe = root.store.subscribe(refresh);
      cleanups.push(() => {
        active = false;
        unsubscribe();
        release();
      });
    }
    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [activeExpanded, db, roots]);
  const rows = useMemo(
    () =>
      projectDelegatedSidebarRows(
        baseRows,
        activeExpanded,
        new Map(
          [...entries]
            .filter(([, entry]) => entry.db === db)
            .map(([id, entry]) => [id, entry.value])
        ),
        limits
      ),
    [activeExpanded, baseRows, db, entries, limits]
  );
  const toggle = useCallback(
    (row: ThreadPanelVisibleRow) => {
      if (row.kind !== 'thread' && row.kind !== 'delegated') {
        return;
      }
      const next = new Map(expanded);
      const closing = next.get(row.id);
      const removed = new Set<string>();
      if (closing) {
        for (const id of collapseDescendants(next, closing)) {
          removed.add(id);
        }
      } else {
        next.set(
          row.id,
          row.kind === 'thread'
            ? {
                depth: row.parentId === null ? 0 : 1,
                groupId: row.groupId,
                id: row.id,
                ownerResourceId: WORKSPACE_MEMORY_RESOURCE_ID,
                parentThreadId: null,
                rootThreadId: row.id,
                threadId: row.id,
              }
            : { ...row.node, depth: row.depth, groupId: row.groupId, id: row.id }
        );
        removed.add(row.id);
      }
      // Expanding starts a new authorized read; old metadata is not a cache authority.
      setEntries((current) => new Map([...current].filter(([id]) => !removed.has(id))));
      setExpanded(next);
    },
    [expanded]
  );
  const showMore = useCallback(
    (id: string) =>
      setLimits((current) =>
        new Map(current).set(
          id,
          (current.get(id) ?? DELEGATED_SIDEBAR_PAGE_SIZE) + DELEGATED_SIDEBAR_PAGE_SIZE
        )
      ),
    []
  );
  return {
    enabled: Boolean(db && roots),
    expandedIds: new Set(activeExpanded.keys()),
    rows,
    showMore,
    toggle,
  };
}

function collapseDescendants(
  next: Map<string, DelegatedSidebarAddress>,
  closing: DelegatedSidebarAddress
): Set<string> {
  const removed = new Set<string>();
  const pending = [closing.threadId];
  while (pending.length > 0) {
    const parentId = pending.pop();
    for (const [id, entry] of next) {
      if (entry.rootThreadId !== closing.rootThreadId) {
        continue;
      }
      if (entry.threadId !== parentId && entry.parentThreadId !== parentId) {
        continue;
      }
      next.delete(id);
      removed.add(id);
      if (entry.threadId !== parentId) {
        pending.push(entry.threadId);
      }
    }
  }
  return removed;
}
