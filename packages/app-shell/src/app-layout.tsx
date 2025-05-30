import { NavigationSidebar, ThemeProvider, ThemeToggle, Toaster } from '@brainstrike/ui';
import type { AppLayoutProps } from './types';

export function AppLayout({
  children,
  config,
  currentPath,
  sidebarContent,
  onNavigationClick,
}: AppLayoutProps) {
  return (
    <ThemeProvider defaultTheme="system" storageKey={config.themeStorageKey}>
      <div className="flex h-screen">
        <NavigationSidebar
          items={config.navigationItems}
          currentPath={currentPath}
          {...(onNavigationClick && { onItemClick: onNavigationClick })}
        >
          <ThemeToggle />
          {sidebarContent}
        </NavigationSidebar>
        <main className="flex-1 overflow-auto p-4 h-full">{children}</main>
      </div>
      <Toaster />
    </ThemeProvider>
  );
}
