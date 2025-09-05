import type { AppLayoutProps } from '@brainstrike/app-shell/src/types';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { FileExplorerProvider } from '@brainstrike/file-explorer-ui';
import {
  ElectronThemeProvider,
  NavigationSidebar,
  ThemeToggle,
  Toaster,
  TooltipProvider,
} from '@brainstrike/ui';

/**
 * Desktop-specific app layout that uses ElectronThemeProvider
 * instead of the regular ThemeProvider for native theme integration.
 */
export function DesktopAppLayout({
  children,
  config,
  currentPath,
  onNavigationClick,
}: AppLayoutProps) {
  const { storageAdapter } = useAdapters();

  return (
    <ElectronThemeProvider defaultTheme="system" storageKey={config.themeStorageKey}>
      <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        <FileExplorerProvider storageAdapter={storageAdapter}>
          <div className="h-full flex">
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
    </ElectronThemeProvider>
  );
}
