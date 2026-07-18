import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { FileExplorerProvider, FileSystemProvider } from '@brainstrike/file-explorer-ui/shell';
import { GlobalDownloadIndicator } from '@brainstrike/preferences/components/global-download-indicator';
import { useDatabaseStatusSync } from '@brainstrike/preferences/hooks/use-database-status-sync';
import {
  NavigationSidebar,
  StatusBar,
  ThemeProvider,
  ThemeToggle,
  Toaster,
  TooltipProvider,
} from '@brainstrike/ui';
import { AccountMenu } from './account-menu';
import { DatabaseStatusItem } from './status-items/database-status-item';
import { IndexingStatusItem } from './status-items/indexing-status-item';
import { WorkspaceRootStatusItem } from './status-items/workspace-root-status-item';
import type { AppLayoutProps } from './types';

export function AppLayout({
  children,
  config,
  currentPath,
  onNavigationClick,
  onOpenSettings,
}: AppLayoutProps) {
  useDatabaseStatusSync();
  const { fileSystemAdapter, storageAdapter } = useAdapters();

  return (
    <ThemeProvider
      defaultTheme="light"
      storageAdapter={storageAdapter}
      storageKey={config.themeStorageKey}
    >
      <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        <FileExplorerProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
          {/* ONE shared file-system instance for the entire app surface
              (explorer, database panel, assistant, settings). MUST mount
              BELOW FileExplorerProvider — the instance reads the store. */}
          <FileSystemProvider>
            <div className="flex h-screen flex-col">
              {/* Main content area */}
              <div className="flex min-h-0 flex-1">
                <NavigationSidebar
                  currentPath={currentPath}
                  items={config.navigationItems}
                  {...(onNavigationClick && { onItemClick: onNavigationClick })}
                >
                  <ThemeToggle />
                  {onOpenSettings ? <AccountMenu onOpenSettings={onOpenSettings} /> : null}
                </NavigationSidebar>
                <main className="h-full flex-1 overflow-hidden">{children}</main>
              </div>
              {/* Status bar at bottom */}
              <StatusBar
                leftContent={
                  <>
                    <DatabaseStatusItem />
                    {/* Workspace root identity (Main vs Focused clarity):
                        renders nothing until a folder is mounted. */}
                    <WorkspaceRootStatusItem />
                  </>
                }
                rightContent={
                  <>
                    <GlobalDownloadIndicator />
                    <IndexingStatusItem />
                  </>
                }
              />
            </div>
            <Toaster />
          </FileSystemProvider>
        </FileExplorerProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
