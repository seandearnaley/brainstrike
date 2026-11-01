import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import { useIdeFileEditor } from '@brainstrike/ui';
import {
  useWorkspaceFileSearch,
  useWorkspaceSearchStore,
  type WorkspaceFileSearch,
  type WorkspaceSearchHit,
} from '@brainstrike/workspace-search/core';
import { useEffect, useRef } from 'react';

const logger = createLogger('WorkspaceSearchController');

const SEARCH_UNAVAILABLE = 'Workspace search is unavailable in this window.';

export interface WorkspaceSearchController {
  onOpenFile: (compositeKey: string, target?: { line: number }) => void;
  rootName: (rootId: string) => string;
  runSearch: () => void;
  workspaceRootCount: number;
}

/** The running search: its store generation, and how to end it. */
interface RunningSearch {
  readonly controller: AbortController;
  readonly generation: number;
}

/**
 * Starts one search of the store's query. Streamed matches are buffered and
 * reach the store once per animation frame, so a burst of batches is one
 * render. The search ends when the store moves on (a new query, an option
 * change, a clear): its ripgrep is cancelled and its late matches dropped.
 */
export function startWorkspaceSearch(
  search: WorkspaceFileSearch,
  previous: RunningSearch | null
): RunningSearch | null {
  previous?.controller.abort(new Error('A newer search replaced this one'));
  const store = useWorkspaceSearchStore.getState();
  const { caseSensitive, isRegex, query, wholeWord } = store;
  if (query.trim().length === 0) {
    return null;
  }
  const generation = store.beginSearch();
  const controller = new AbortController();
  let pending: WorkspaceSearchHit[] = [];
  let frame: number | undefined;
  const flush = (): void => {
    frame = undefined;
    const hits = pending;
    pending = [];
    useWorkspaceSearchStore.getState().appendMatches(hits, generation);
  };
  const stopWhenReplaced = useWorkspaceSearchStore.subscribe((state) => {
    if (state.generation !== generation) {
      controller.abort(new Error('The search was replaced'));
    }
  });
  controller.signal.addEventListener(
    'abort',
    () => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
        frame = undefined;
      }
      pending = [];
    },
    { once: true }
  );
  search
    .search(
      { caseSensitive, isRegex, query, wholeWord },
      (hits) => {
        if (controller.signal.aborted) {
          return;
        }
        pending.push(...hits);
        frame ??= requestAnimationFrame(flush);
      },
      controller.signal
    )
    .then(
      (summary) => {
        if (frame !== undefined) {
          cancelAnimationFrame(frame);
        }
        flush();
        useWorkspaceSearchStore.getState().completeSearch(summary, generation);
      },
      (error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        useWorkspaceSearchStore.getState().failSearch(describeBoundaryError(error), generation);
      }
    )
    .finally(stopWhenReplaced);
  return { controller, generation };
}

/**
 * Composition-layer controller for the workspace-search panel: runs the
 * frame's live search over the store's query, and derives folder names and the
 * file-open seam from the surrounding Explorer and IDE providers.
 */
export function useWorkspaceSearchController(): WorkspaceSearchController {
  const search = useWorkspaceFileSearch();
  const { openFileInTab } = useIdeFileEditor();
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const rootDescriptors = useFileExplorerStoreSelector((state) => state.rootDescriptors);
  const running = useRef<RunningSearch | null>(null);

  // Unmounting the Search tab ends its search.
  useEffect(
    () => () => {
      running.current?.controller.abort(new Error('Workspace search was closed'));
      running.current = null;
    },
    []
  );

  const runSearch = (): void => {
    if (!search) {
      const generation = useWorkspaceSearchStore.getState().beginSearch();
      useWorkspaceSearchStore.getState().failSearch(SEARCH_UNAVAILABLE, generation);
      return;
    }
    running.current = startWorkspaceSearch(search, running.current);
  };

  const rootName = (rootId: string): string => rootDescriptors[rootId]?.displayName ?? rootId;

  const onOpenFile = (compositeKey: string, target?: { line: number }): void => {
    if (!openFileInTab) {
      logger.error('Workspace search selected a file but the file-open seam is unavailable', {
        compositeKey,
      });
      return;
    }
    // Surface the explorer route so the opened tab is visible.
    setActiveTab('explorer');
    openFileInTab(compositeKey, target ? { line: target.line } : undefined);
  };

  return {
    onOpenFile,
    rootName,
    runSearch,
    workspaceRootCount: Object.keys(rootDescriptors).length,
  };
}
