import type { DeleteRootData } from '@brainstrike/file-explorer-ui/shell';
import type { ComponentType, ReactNode } from 'react';

export interface NavigationItem {
  icon: ComponentType<{ className?: string }>;
  name: string;
  path: string;
}

export interface AppShellConfig {
  description: string;
  navigationItems: NavigationItem[];
  themeStorageKey: string;
  title: string;
}

export interface AppLayoutProps {
  children: ReactNode;
  config: AppShellConfig;
  currentPath: string;
  deleteRootData?: DeleteRootData;
  onNavigationClick?: (path: string) => void;
  sidebarContent?: ReactNode;
}

export interface RouteConfig {
  element: ReactNode;
  index?: boolean;
  path: string;
}
