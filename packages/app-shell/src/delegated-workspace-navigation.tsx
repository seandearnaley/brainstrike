import { SubagentConversationNavigationContext } from '@brainstrike/assistant-ui';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { type ReactNode, useCallback } from 'react';
import { delegatedWorkspaceTabId } from './delegated-workspace-tab';
import { useDelegatedConversationRoot } from './use-delegated-conversation-root';

/** Both main and child cards use the existing workspace's singleton tab action. */
export function DelegatedWorkspaceNavigation({
  children,
  ownerResourceId,
  rootThreadId,
}: {
  readonly children: ReactNode;
  readonly ownerResourceId: string;
  readonly rootThreadId: string | undefined;
}) {
  const root = useDelegatedConversationRoot(ownerResourceId, rootThreadId);
  const open = useCallback(
    (threadId: string) => {
      if (!rootThreadId) {
        throw new Error('The owning conversation is unavailable.');
      }
      useWorkspaceTabSelectionStore
        .getState()
        .openApp(delegatedWorkspaceTabId({ ownerResourceId, rootThreadId, threadId }));
    },
    [ownerResourceId, rootThreadId]
  );
  return (
    <SubagentConversationNavigationContext value={root ? open : null}>
      {children}
    </SubagentConversationNavigationContext>
  );
}
