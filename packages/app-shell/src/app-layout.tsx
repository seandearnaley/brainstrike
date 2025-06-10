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
  const { fileExplorerStore } = useAdapters();

  return (
    <ThemeProvider defaultTheme="system" storageKey={config.themeStorageKey}>
      <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        <FileExplorerProvider store={fileExplorerStore}>
          <div className="h-screen flex">
            <NavigationSidebar
              items={config.navigationItems}
              currentPath={currentPath}
              {...(onNavigationClick && { onItemClick: onNavigationClick })}
            >
              <ThemeToggle />
            </NavigationSidebar>
            <main className="flex-1 h-full overflow-hidden">{children}</main>
          </div>
          <Toaster />
        </FileExplorerProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
