import { type WorkspaceApp, WorkspaceTabsProvider } from '@brainstrike/file-explorer-ui/shell';
import { type ReactNode, useMemo } from 'react';
import { useCanvasWorkspaceApps } from './canvas/use-canvas-workspace-apps';
import { useHostChildWorkspaceApps } from './use-host-child-workspace-apps';
export function DelegatedWorkspaceTabsProvider({
  apps,
  canvasShellSrc,
  children,
}: {
  readonly apps: readonly WorkspaceApp[];
  /** The Canvas shell URL; absent on a host without canvases, which opens no canvas tab. */
  readonly canvasShellSrc: string | undefined;
  readonly children: ReactNode;
}) {
  const hostChildApps = useHostChildWorkspaceApps();
  const canvasApps = useCanvasWorkspaceApps(canvasShellSrc);
  const allApps = useMemo(
    () => [...apps, ...hostChildApps, ...canvasApps],
    [apps, hostChildApps, canvasApps]
  );
  return <WorkspaceTabsProvider apps={allApps}>{children}</WorkspaceTabsProvider>;
}
