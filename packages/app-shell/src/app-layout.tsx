import { IdeLayout, ThemeProvider, ThemeToggle, Toaster, TooltipProvider } from '@brainstrike/ui';
import type { AppLayoutProps } from './types';

export function AppLayout({
  children,
  config,
  currentPath,
  sidebarContent,
  onNavigationClick,
}: AppLayoutProps) {
  // Only show console content on the explorer page (not on settings)
  const isExplorerPage = currentPath === '/';

  return (
    <ThemeProvider defaultTheme="system" storageKey={config.themeStorageKey}>
      <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        <IdeLayout
          navigationItems={config.navigationItems}
          currentPath={currentPath}
          {...(onNavigationClick && { onNavigationClick })}
          leftPanelContent={sidebarContent}
          rightPanelContent={
            sidebarContent ? (
              <div className="p-4 text-sm text-muted-foreground">
                Additional tools and panels will appear here...
              </div>
            ) : undefined
          }
          consoleContent={
            isExplorerPage ? (
              <div className="p-4 text-sm text-muted-foreground">
                Console output will appear here...
              </div>
            ) : undefined
          }
          navigationChildren={<ThemeToggle />}
        >
          <main className="p-4 h-full overflow-hidden">{children}</main>
        </IdeLayout>
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}
