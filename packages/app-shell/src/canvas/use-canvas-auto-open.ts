import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { useEffect } from 'react';
import { useAssistantThreadHost } from '../assistant-thread-host-context';
import { readHostChildWorkspaceTab } from '../host-child-workspace-tab';
import { canvasWorkspaceTabId } from './canvas-workspace-tab';

/** The thread's view is on screen: the active thread, or a child conversation open in its workspace. */
function isShownThread(threadId: string): boolean {
  const active =
    useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID];
  if (threadId === active) {
    return true;
  }
  return useWorkspaceTabSelectionStore.getState().openAppIds.some((id) => {
    try {
      return readHostChildWorkspaceTab(id)?.threadId === threadId;
    } catch {
      // A corrupted child address shows its own failure in its tab.
      return false;
    }
  });
}

/**
 * A canvas the assistant writes opens in its own tab as the version commits,
 * the way Claude and ChatGPT show an artifact the moment it is written. Only a
 * thread on screen opens tabs, and a tab that is already open keeps the
 * person's current selection: its view re-reads in place.
 */
export function useCanvasAutoOpen(enabled: boolean): void {
  const host = useAssistantThreadHost();
  useEffect(() => {
    if (!enabled) {
      return;
    }
    return host?.subscribeCanvasCommits?.(({ canvasId, threadId }) => {
      const appId = canvasWorkspaceTabId({ canvasId, threadId });
      const tabs = useWorkspaceTabSelectionStore.getState();
      if (isShownThread(threadId) && !tabs.openAppIds.includes(appId)) {
        tabs.openApp(appId);
      }
    });
  }, [enabled, host]);
}
