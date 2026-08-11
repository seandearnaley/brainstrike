import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import { getGroupMemberIds, type ThreadListView } from '@brainstrike/assistant-data';
import { useCallback, useMemo, useState } from 'react';
import {
  buildThreadPanelVisibleRows,
  THREAD_PANEL_DISCLOSURE_INCREMENT,
  THREAD_PANEL_INITIAL_VISIBLE_LIMIT,
  type ThreadPanelVisibleRowsResult,
} from './thread-panel-visible-rows';

export interface ThreadPanelSelection {
  /** True only when every disclosed thread is selected (never true for an empty list). */
  readonly allVisibleSelected: boolean;
  readonly clearSelection: () => void;
  readonly onShowMore: (sectionKey: string) => void;
  /** Selection narrowed to threads that still exist in the store. */
  readonly replaceSelection: (nextIds: ReadonlySet<string>) => void;
  readonly selectedThreadIds: ReadonlySet<string>;
  readonly selectGroup: (groupId: string | null, nextState: 'checked' | 'unchecked') => void;
  readonly toggleVisibleSelection: () => void;
  readonly visibleRows: ThreadPanelVisibleRowsResult;
}

/**
 * Owns thread-panel disclosure limits and bulk selection.
 *
 * This state lives at the panel level rather than inside the tree because the
 * panel toolbar renders the visible count and the select-visible control in the
 * same row as the heading — one source of truth read by both the toolbar and
 * the treegrid, not two copies kept in sync.
 */
export function useThreadPanelSelection({
  collapsedGroupIds,
  threads,
  view,
}: {
  readonly collapsedGroupIds: Record<string, true>;
  readonly threads: readonly AssistantMemoryThread[];
  readonly view: ThreadListView;
}): ThreadPanelSelection {
  const [limitsBySectionKey, setLimitsBySectionKey] = useState<Readonly<Record<string, number>>>(
    {}
  );
  const [selectedThreadIds, setSelectedThreadIds] = useState<ReadonlySet<string>>(() => new Set());

  const visibleRows = useMemo(
    () => buildThreadPanelVisibleRows({ collapsedGroupIds, limitsBySectionKey, view }),
    [collapsedGroupIds, limitsBySectionKey, view]
  );
  const selectableThreadIds = useMemo(() => new Set(threads.map((thread) => thread.id)), [threads]);
  const selectedAvailableThreadIds = useMemo(
    () => new Set([...selectedThreadIds].filter((threadId) => selectableThreadIds.has(threadId))),
    [selectableThreadIds, selectedThreadIds]
  );

  const onShowMore = useCallback((sectionKey: string): void => {
    setLimitsBySectionKey((currentLimits) => ({
      ...currentLimits,
      [sectionKey]:
        (currentLimits[sectionKey] ?? THREAD_PANEL_INITIAL_VISIBLE_LIMIT) +
        THREAD_PANEL_DISCLOSURE_INCREMENT,
    }));
  }, []);

  const replaceSelection = useCallback(
    (nextIds: ReadonlySet<string>): void => {
      setSelectedThreadIds(
        new Set([...nextIds].filter((threadId) => selectableThreadIds.has(threadId)))
      );
    },
    [selectableThreadIds]
  );

  const selectGroup = useCallback(
    (groupId: string | null, nextState: 'checked' | 'unchecked'): void => {
      const memberIds = getGroupMemberIds(view, groupId);
      setSelectedThreadIds((currentIds) => {
        const nextIds = new Set(
          [...currentIds].filter((threadId) => selectableThreadIds.has(threadId))
        );
        for (const threadId of memberIds) {
          if (nextState === 'checked') {
            nextIds.add(threadId);
          } else {
            nextIds.delete(threadId);
          }
        }
        return nextIds;
      });
    },
    [selectableThreadIds, view]
  );

  const clearSelection = useCallback((): void => setSelectedThreadIds(new Set()), []);

  const allVisibleSelected =
    visibleRows.visibleThreadIds.length > 0 &&
    visibleRows.visibleThreadIds.every((threadId) => selectedAvailableThreadIds.has(threadId));

  // The direction is derived inside the updater so the decision and the write
  // come from one snapshot, and so the callback identity does not churn on
  // every selection change.
  const toggleVisibleSelection = useCallback((): void => {
    setSelectedThreadIds((currentIds) => {
      const nextIds = new Set(
        [...currentIds].filter((threadId) => selectableThreadIds.has(threadId))
      );
      const shouldClear =
        visibleRows.visibleThreadIds.length > 0 &&
        visibleRows.visibleThreadIds.every((threadId) => nextIds.has(threadId));
      for (const threadId of visibleRows.visibleThreadIds) {
        if (shouldClear) {
          nextIds.delete(threadId);
        } else {
          nextIds.add(threadId);
        }
      }
      return nextIds;
    });
  }, [selectableThreadIds, visibleRows.visibleThreadIds]);

  return {
    allVisibleSelected,
    clearSelection,
    onShowMore,
    replaceSelection,
    selectedThreadIds: selectedAvailableThreadIds,
    selectGroup,
    toggleVisibleSelection,
    visibleRows,
  };
}
