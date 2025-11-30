import type { ComponentType, ReactNode } from 'react';

export type NavigationItem = {
  name: string;
  icon: ComponentType<{ className?: string }>;
  path: string;
};

export type AppShellConfig = {
  title: string;
  description: string;
  themeStorageKey: string;
  navigationItems: NavigationItem[];
};

export type AppLayoutProps = {
  children: ReactNode;
  config: AppShellConfig;
  currentPath: string;
  sidebarContent?: ReactNode;
  onNavigationClick?: (path: string) => void;
};

export type RouteConfig = {
  path: string;
  element: ReactNode;
  index?: boolean;
};
