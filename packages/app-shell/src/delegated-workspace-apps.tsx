import { type WorkspaceApp, WorkspaceTabsProvider } from '@brainstrike/file-explorer-ui/shell';
import { type ReactNode, useMemo } from 'react';
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
  const allApps = useMemo(() => [...apps, ...childApps], [apps, childApps]);
  return (
    <DelegatedConversationRootsProvider>
      <WorkspaceTabsProvider apps={allApps}>{children}</WorkspaceTabsProvider>
    </DelegatedConversationRootsProvider>
  );
}
