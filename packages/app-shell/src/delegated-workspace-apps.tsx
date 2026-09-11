import { type WorkspaceApp, WorkspaceTabsProvider } from '@brainstrike/file-explorer-ui/shell';
import type { ReactNode } from 'react';
import { DelegatedConversationRootsProvider } from './delegated-conversation-root';
import { useDelegatedWorkspaceApps } from './use-delegated-workspace-apps';
export function DelegatedWorkspaceTabsProvider({
  apps,
  children,
}: {
  readonly apps: readonly WorkspaceApp[];
  readonly children: ReactNode;
}) {
  const childApps = useDelegatedWorkspaceApps();
  return (
    <DelegatedConversationRootsProvider>
      <WorkspaceTabsProvider apps={[...apps, ...childApps]}>{children}</WorkspaceTabsProvider>
    </DelegatedConversationRootsProvider>
  );
}
