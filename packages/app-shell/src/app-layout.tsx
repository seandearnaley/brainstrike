import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { FileExplorerProvider } from '@brainstrike/file-explorer-ui';
import {
  NavigationSidebar,
  ThemeProvider,
  ThemeToggle,
  Toaster,
  TooltipProvider,
} from '@brainstrike/ui';
import type { AppLayoutProps } from './types';

export function AppLayout({ children, config, currentPath, onNavigationClick }: AppLayoutProps) {
  const { storageAdapter } = useAdapters();

  return (
    <ThemeProvider defaultTheme="system" storageKey={config.themeStorageKey}>
      <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        <FileExplorerProvider storageAdapter={storageAdapter}>
          <div className="h-screen min-h-0 flex">
            <NavigationSidebar
              items={config.navigationItems}
              currentPath={currentPath}
              {...(onNavigationClick && { onItemClick: onNavigationClick })}
            >
              <ThemeToggle />
            </NavigationSidebar>
            <main className="flex-1 h-full min-h-0">{children}</main>
          </div>
          <Toaster />
        </FileExplorerProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
