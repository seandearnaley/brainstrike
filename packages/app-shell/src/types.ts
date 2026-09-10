import type { ComponentType, ReactNode } from 'react';

export interface NavigationItem {
  icon: ComponentType<{ className?: string }>;
  name: string;
  path: string;
}

export interface AppShellConfig {
  description: string;
  navigationItems: NavigationItem[];
  themePaletteStorageKey: string;
  themeStorageKey: string;
  title: string;
}

export interface AppLayoutProps {
  children: ReactNode;
  config: AppShellConfig;
  currentPath: string;
  onNavigationClick?: (path: string) => void;
  onOpenSettings?: () => void;
  sidebarContent?: ReactNode;
}

export interface RouteConfig {
  element: ReactNode;
  index?: boolean;
  path: string;
}
