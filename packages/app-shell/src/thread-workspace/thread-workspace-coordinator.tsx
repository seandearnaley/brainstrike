import {
  createThreadWorkspaceRepository,
  resolveAssistantMemoryResourceId,
  useAssistantThreadStore,
} from '@brainstrike/assistant-data';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useEditorViewStateStore } from '@brainstrike/file-explorer-ui/editor-view-state-store';
import { useFileTabPaneStore } from '@brainstrike/file-explorer-ui/file-tab-pane-store';
import { useFileExplorerStoreContext } from '@brainstrike/file-explorer-ui/shell';
import { useTabManagerStore } from '@brainstrike/file-explorer-ui/tab-manager-store';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { useCallback, useMemo } from 'react';
import { useAssistantThreadHost } from '../assistant-thread-host-context';
import { threadWorkspaceNavigation } from './live-thread-workspace-navigation';
import { createLiveWorkspaceFacade } from './thread-workspace-live-facade';
import { useThreadWorkspaceCoordinator } from './use-thread-workspace-coordinator';

const EMPTY_THREAD_IDS: readonly string[] = [];

/**
 * Mounts the thread⇄workspace coordinator (BST-1268). Must render inside the
 * FileExplorerProvider (app-shell's AppLayout provides it). The host owns desktop
 * snapshots; web uses its database provider. Renders nothing.
 */
export function ThreadWorkspaceCoordinator(): null {
  const host = useAssistantThreadHost();
  const db = usePGliteDatabase({ enabled: !host });
  const repository = useMemo(() => {
    if (host) {
      return host.workspaceRepository();
    }
    return db ? createThreadWorkspaceRepository(db) : null;
  }, [db, host]);
  const resourceId = resolveAssistantMemoryResourceId();
  const activeThreadId = useAssistantThreadStore(
    (state) => state.activeThreadIdByResourceId[resourceId] ?? null
  );
  const openThreadIds = useAssistantThreadStore(
    (state) => state.openThreadIdsByResourceId[resourceId] ?? EMPTY_THREAD_IDS
  );
  const fileExplorerStore = useFileExplorerStoreContext();
  const facade = useMemo(() => createLiveWorkspaceFacade(fileExplorerStore), [fileExplorerStore]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribers = [
        // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- This callback is a subscription AGGREGATOR, not a leak: it returns the unsubscribe-all closure, and its only caller (useThreadWorkspaceCoordinator's save effect) invokes it inside useEffect and returns that closure as the effect cleanup.
        useWorkspaceTabSelectionStore.subscribe(listener),
        useTabManagerStore.subscribe(listener),
        useEditorViewStateStore.subscribe(listener),
        useFileTabPaneStore.subscribe(listener),
        fileExplorerStore.subscribe(listener),
      ];
      return () => {
        for (const unsubscribe of unsubscribers) {
          unsubscribe();
        }
      };
    },
    [fileExplorerStore]
  );

  useThreadWorkspaceCoordinator({
    activeThreadId,
    facade,
    navigation: threadWorkspaceNavigation,
    openThreadIds,
    repository,
    resourceId,
    subscribe,
  });

  return null;
}
