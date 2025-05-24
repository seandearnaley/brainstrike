import type { ComponentType, ReactNode } from 'react';

export interface NavigationItem {
  name: string;
  icon: ComponentType<{ className?: string }>;
  path: string;
}

export interface AppShellConfig {
  title: string;
  description: string;
  themeStorageKey: string;
  navigationItems: NavigationItem[];
}

export interface AppLayoutProps {
  children: ReactNode;
  config: AppShellConfig;
  currentPath: string;
  sidebarContent?: ReactNode;
}

export interface RouteConfig {
  path: string;
  element: ReactNode;
  index?: boolean;
}
