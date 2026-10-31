import {
  type WorkspaceApp,
  type WorkspaceLaunchAction,
  WorkspaceTabsProvider,
} from '@brainstrike/file-explorer-ui/shell';
import { toast } from '@brainstrike/ui';
import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { Globe } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BrowserBridge } from './browser-pane/browser-bridge';
import { openBrowserPage } from './browser-pane/browser-pages';
import { useBrowserWorkspaceApps } from './browser-pane/use-browser-workspace-apps';
import { useCanvasWorkspaceApps } from './canvas/use-canvas-workspace-apps';
import { useHostChildWorkspaceApps } from './use-host-child-workspace-apps';

const NEW_BROWSER_PAGE: WorkspaceLaunchAction = {
  description: 'Browse the web beside this conversation',
  icon: Globe,
  id: 'new-browser-tab',
  label: 'New browser tab',
  run: () => {
    openBrowserPage().catch((error: unknown) => {
      toast({
        description: getErrorMessage(error),
        title: 'Unable to open a browser tab',
        variant: 'destructive',
      });
    });
  },
};

export function DelegatedWorkspaceTabsProvider({
  apps,
  browser,
  canvasShellSrc,
  children,
}: {
  readonly apps: readonly WorkspaceApp[];
  /** The desktop browser; null on a host without one, which opens no page tab. */
  readonly browser: BrowserBridge | null;
  /** The Canvas shell URL; absent on a host without canvases, which opens no canvas tab. */
  readonly canvasShellSrc: string | undefined;
  readonly children: ReactNode;
}) {
  const hostChildApps = useHostChildWorkspaceApps();
  const canvasApps = useCanvasWorkspaceApps(canvasShellSrc);
  const browserApps = useBrowserWorkspaceApps(browser);
  const allApps = [...apps, ...hostChildApps, ...canvasApps, ...browserApps];
  const launchActions = browser ? [NEW_BROWSER_PAGE] : [];
  return (
    <WorkspaceTabsProvider apps={allApps} launchActions={launchActions}>
      {children}
    </WorkspaceTabsProvider>
  );
}
