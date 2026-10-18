import type {
  IndexRetryCapability,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import type { ComponentType, ReactNode } from 'react';
import type { StateHealthCapability } from './state-health/state-health-capability';

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
  /** Retry indexing after the embedding host stopped responding; desktop injects it. */
  readonly nativeIndexRetry?: IndexRetryCapability | null;
  readonly nativeIndexSearch?: IndexSearchCapability | null;
  onNavigationClick?: (path: string) => void;
  onOpenSettings?: () => void;
  sidebarContent?: ReactNode;
  /** The canonical state store's health and recovery (BST-1880); desktop supplies it. */
  readonly stateHealth?: StateHealthCapability | null;
}

export interface RouteConfig {
  element: ReactNode;
  index?: boolean;
  path: string;
}
