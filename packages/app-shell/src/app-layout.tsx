import {
  NavigationSidebar,
  ScrollArea,
  ThemeProvider,
  ThemeToggle,
  Toaster,
} from '@brainstrike/ui';
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
        <ScrollArea className="flex-1 p-4 h-full">{children}</ScrollArea>
      </div>
      <Toaster />
    </ThemeProvider>
  );
}
