import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { FileExplorerProvider } from '@brainstrike/file-explorer-ui';
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
import { DatabaseStatusItem, IndexingStatusItem } from './status-items';
import type { AppLayoutProps } from './types';

export function AppLayout({ children, config, currentPath, onNavigationClick }: AppLayoutProps) {
  useDatabaseStatusSync();
  const { fileSystemAdapter, storageAdapter } = useAdapters();

  return (
    <ThemeProvider defaultTheme="light" storageKey={config.themeStorageKey}>
      <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        <FileExplorerProvider fileSystemAdapter={fileSystemAdapter} storageAdapter={storageAdapter}>
          <div className="flex h-screen flex-col">
            {/* Main content area */}
            <div className="flex min-h-0 flex-1">
              <NavigationSidebar
                currentPath={currentPath}
                items={config.navigationItems}
                {...(onNavigationClick && { onItemClick: onNavigationClick })}
              >
                <ThemeToggle />
              </NavigationSidebar>
              <main className="h-full flex-1 overflow-hidden">{children}</main>
            </div>
            {/* Status bar at bottom */}
            <StatusBar
              centerContent={
                <div className="flex items-center gap-3">
                  <IndexingStatusItem />
                </div>
              }
              leftContent={<DatabaseStatusItem />}
              rightContent={<GlobalDownloadIndicator />}
            />
          </div>
          <Toaster />
        </FileExplorerProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
