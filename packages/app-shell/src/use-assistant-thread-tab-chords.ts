import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import {
  type ActionOutcome,
  createClosedTabHistory,
  NO_CLOSED_TAB_OUTCOME,
  placeTabAtIndex,
  recordRemovedTabs,
} from '@brainstrike/context-actions';
import { type RefObject, useCallback, useMemo, useState } from 'react';
import { type TabChordStrip, useTabChordStrip } from './tab-chords/tab-chord-registry';

const EMPTY_THREAD_IDS: readonly string[] = [];

/** A closed thread tab, remembered for Reopen Closed Tab (session-only). */
interface ClosedThreadTab {
  readonly threadId: string;
  readonly title: string;
}

/**
 * The assistant strip's close paths, each recorded for Reopen Closed Tab, plus
 * the reopen itself (the one ⌘⇧T, the palette and the strip menu share).
 */
export interface AssistantThreadTabCloses {
  readonly close: (threadId: string) => void;
  readonly closeAll: () => void;
  readonly closeOthers: (threadId: string) => void;
  readonly closeToRight: (threadId: string) => void;
  readonly hasClosedTabs: () => boolean;
  readonly reopenClosed: () => Promise<ActionOutcome>;
}

function threadTitle(resourceId: string, threadId: string): string {
  const loaded = useAssistantThreadStore.getState().threadsByResourceId[resourceId] ?? [];
  return loaded.find((thread) => thread.id === threadId)?.title ?? threadId;
}

/**
 * The assistant thread strip's closed-tab history and its chord registration
 * (BST-1842). Every close path (✕, Delete, the menus, chords) goes through the
 * returned closes, which record exactly what the store removed. Session-only:
 * the history lives and dies with the strip, so it needs no factory-reset
 * wiring. Focus inside `panelRef` scopes chords to this strip.
 */
export function useAssistantThreadTabChords(
  resourceId: string,
  panelRef: RefObject<HTMLElement | null>
): AssistantThreadTabCloses {
  const closeAllThreadTabs = useAssistantThreadStore((state) => state.closeAllThreadTabs);
  const closeOtherThreadTabs = useAssistantThreadStore((state) => state.closeOtherThreadTabs);
  const closeThreadTab = useAssistantThreadStore((state) => state.closeThreadTab);
  const closeThreadTabsToRight = useAssistantThreadStore((state) => state.closeThreadTabsToRight);
  const openThreadTab = useAssistantThreadStore((state) => state.openThreadTab);
  const reorderThreadTabs = useAssistantThreadStore((state) => state.reorderThreadTabs);

  const [closedTabs] = useState(() => createClosedTabHistory<ClosedThreadTab>());
  const readOpenThreadIds = useCallback(
    (): readonly string[] =>
      useAssistantThreadStore.getState().openThreadIdsByResourceId[resourceId] ?? EMPTY_THREAD_IDS,
    [resourceId]
  );

  /** Run a store close, then record exactly the tabs it removed, at their old indices. */
  const closeRecorded = useCallback(
    (close: () => void): void => {
      const before = readOpenThreadIds().map((threadId) => ({
        id: threadId,
        tab: { threadId, title: threadTitle(resourceId, threadId) },
      }));
      close();
      recordRemovedTabs(closedTabs, before, readOpenThreadIds());
    },
    [closedTabs, readOpenThreadIds, resourceId]
  );
  const closes = useMemo<
    Pick<AssistantThreadTabCloses, 'close' | 'closeAll' | 'closeOthers' | 'closeToRight'>
  >(
    () => ({
      close: (threadId) => closeRecorded(() => closeThreadTab(resourceId, threadId)),
      closeAll: () => closeRecorded(() => closeAllThreadTabs(resourceId)),
      closeOthers: (threadId) => closeRecorded(() => closeOtherThreadTabs(resourceId, threadId)),
      closeToRight: (threadId) => closeRecorded(() => closeThreadTabsToRight(resourceId, threadId)),
    }),
    [
      closeAllThreadTabs,
      closeOtherThreadTabs,
      closeRecorded,
      closeThreadTab,
      closeThreadTabsToRight,
      resourceId,
    ]
  );

  /**
   * Reopen the most recently closed tab at its old index (or the end) and
   * activate it. A thread deleted since it closed is dropped and reported.
   */
  const reopenClosed = useCallback((): Promise<ActionOutcome> => {
    const closed = closedTabs.pop();
    if (!closed) {
      return Promise.resolve(NO_CLOSED_TAB_OUTCOME);
    }
    const { threadId, title } = closed.tab;
    const loaded = useAssistantThreadStore.getState().threadsByResourceId[resourceId] ?? [];
    if (!loaded.some((thread) => thread.id === threadId)) {
      return Promise.resolve({
        error: `"${title}" was deleted and cannot be reopened`,
        ok: false,
      });
    }
    const wasOpen = readOpenThreadIds().includes(threadId);
    openThreadTab(resourceId, threadId);
    if (!wasOpen) {
      reorderThreadTabs(resourceId, placeTabAtIndex(readOpenThreadIds(), threadId, closed.index));
    }
    return Promise.resolve({ ok: true });
  }, [closedTabs, openThreadTab, readOpenThreadIds, reorderThreadTabs, resourceId]);

  const hasClosedTabs = useCallback((): boolean => closedTabs.size() > 0, [closedTabs]);

  const chordStrip = useMemo<TabChordStrip>(
    () => ({
      activate: (threadId) => openThreadTab(resourceId, threadId),
      close: closes.close,
      getActiveId: () =>
        useAssistantThreadStore.getState().activeThreadIdByResourceId[resourceId] ?? null,
      getPanel: () => panelRef.current,
      getTabs: () =>
        readOpenThreadIds().map((threadId) => ({
          id: threadId,
          label: threadTitle(resourceId, threadId),
        })),
      hasClosedTabs,
      reopenClosed,
    }),
    [closes, hasClosedTabs, openThreadTab, panelRef, readOpenThreadIds, reopenClosed, resourceId]
  );
  useTabChordStrip('assistant-threads', chordStrip);

  return useMemo<AssistantThreadTabCloses>(
    () => ({ ...closes, hasClosedTabs, reopenClosed }),
    [closes, hasClosedTabs, reopenClosed]
  );
}
