import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { toast } from '@brainstrike/ui';
import { ThreadWorkspaceNavigation } from './thread-workspace-navigation';

export const threadWorkspaceNavigation = new ThreadWorkspaceNavigation({
  activateThread: (resourceId, threadId) =>
    useAssistantThreadStore.getState().openThreadTab(resourceId, threadId),
  openApp: (appId) => useWorkspaceTabSelectionStore.getState().openApp(appId),
  reportError: (error) =>
    toast({
      description: error instanceof Error ? error.message : String(error),
      title: 'Unable to open child workspace',
      variant: 'destructive',
    }),
});
