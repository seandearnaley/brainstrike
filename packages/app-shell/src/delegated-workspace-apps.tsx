import { type WorkspaceApp, WorkspaceTabsProvider } from '@brainstrike/file-explorer-ui/shell';
import { type ReactNode, useMemo } from 'react';
import { useHostChildWorkspaceApps } from './use-host-child-workspace-apps';
export function DelegatedWorkspaceTabsProvider({
  apps,
  children,
}: {
  readonly apps: readonly WorkspaceApp[];
  readonly children: ReactNode;
}) {
  const hostChildApps = useHostChildWorkspaceApps();
  const allApps = useMemo(() => [...apps, ...hostChildApps], [apps, hostChildApps]);
  return <WorkspaceTabsProvider apps={allApps}>{children}</WorkspaceTabsProvider>;
}
