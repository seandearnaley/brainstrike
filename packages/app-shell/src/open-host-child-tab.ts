import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import type { AssistantThreadHostChild } from './assistant-thread-host-context';
import { hostChildWorkspaceTabId } from './host-child-workspace-tab';

/**
 * The child's workspace tab opens, then takes focus as the ordinary thread-tab
 * shell does, unless `focus` puts it somewhere the person was before.
 */
export function openHostChildTab(
  child: Pick<AssistantThreadHostChild, 'persona' | 'threadId'>,
  focus?: () => boolean
): void {
  const appId = hostChildWorkspaceTabId({ persona: child.persona, threadId: child.threadId });
  useWorkspaceTabSelectionStore.getState().openApp(appId);
  window.requestAnimationFrame(() => {
    if (!focus?.()) {
      document.getElementById(`workspace-app-tab-${appId}`)?.focus();
    }
  });
}
