import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { FileExplorerProvider } from '@brainstrike/file-explorer-ui';
import { useDatabaseStatusSync } from '@brainstrike/preferences';
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
          <div className="h-screen flex flex-col">
            {/* Main content area */}
            <div className="flex-1 flex min-h-0">
              <NavigationSidebar
                items={config.navigationItems}
                currentPath={currentPath}
                {...(onNavigationClick && { onItemClick: onNavigationClick })}
              >
                <ThemeToggle />
              </NavigationSidebar>
              <main className="flex-1 h-full overflow-hidden">{children}</main>
            </div>
            {/* Status bar at bottom */}
            <StatusBar leftContent={<DatabaseStatusItem />} />
          </div>
          <Toaster />
        </FileExplorerProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
