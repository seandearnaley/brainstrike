import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { FileExplorerProvider } from '@brainstrike/file-explorer-ui';
import { GlobalDownloadIndicator, useDatabaseStatusSync } from '@brainstrike/preferences';
import {
  NavigationSidebar,
  StatusBar,
  ThemeProvider,
  ThemeToggle,
  Toaster,
  TooltipProvider,
} from '@brainstrike/ui';
import { DatabaseStatusItem } from './status-items';
import type { AppLayoutProps } from './types';

export function AppLayout({ children, config, currentPath, onNavigationClick }: AppLayoutProps) {
  useDatabaseStatusSync();
  const { storageAdapter } = useAdapters();

  return (
    <ThemeProvider defaultTheme="system" storageKey={config.themeStorageKey}>
      <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        <FileExplorerProvider storageAdapter={storageAdapter}>
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
