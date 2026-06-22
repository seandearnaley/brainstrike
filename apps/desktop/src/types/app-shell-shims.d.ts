/**
 * Type shims for @brainstrike/app-shell package used in desktop renderer.
 *
 * These type definitions exist because the desktop app uses Vite aliases to resolve
 * @brainstrike/app-shell at runtime (see vite.config.mts). TypeScript needs these
 * explicit type declarations to understand the module structure during type checking.
 *
 * ⚠️ IMPORTANT: These types MUST stay in sync with the actual implementation.
 * Source of truth: packages/app-shell/src/
 *
 * Related files:
 * - packages/app-shell/src/settings-page-content.tsx (SettingsCategory, SettingsPageContent)
 * - packages/app-shell/src/navigation.ts (navigationItems)
 * - packages/app-shell/src/root-layout-content.tsx (RootLayoutContent)
 */
import type React from 'react';
import type { LucideIcon } from 'lucide-react';

declare module '@brainstrike/app-shell/navigation' {
  export const navigationItems: unknown;
}

declare module '@brainstrike/app-shell/types' {
  export interface NavigationItem {
    icon: React.ComponentType<{ className?: string }>;
    name: string;
    path: string;
  }
}

declare module '@brainstrike/app-shell/root-layout-content' {
  export const RootLayoutContent: React.ComponentType;
  export interface RootLayoutContentProps {
    contextExplorerPageContent: React.ReactNode;
    contextExplorerPanelContent?: React.ReactNode;
    databaseTabChunkingMode?: 'host-proxy' | 'local';
    gitPageContent?: React.ReactNode;
    loadEmbeddingQueue?: (() => Promise<unknown>) | null;
    navigationItems: unknown[];
    preloadDatabaseTabOnMount?: boolean;
    promptsPageContent?: React.ReactNode;
    settingsPageContent: React.ReactNode;
  }
}

declare module '@brainstrike/app-shell/git-panel' {
  export const GitPanel: React.ComponentType;
  /** True when the desktop `window.git` bridge is present and fully formed. */
  export function isGitBridgeAvailable(): boolean;
}

declare module '@brainstrike/app-shell/git-panel/availability' {
  /** True when the desktop `window.git` bridge is present and fully formed. */
  export function isGitBridgeAvailable(): boolean;
}

declare module '@brainstrike/app-shell/connected-prompt-manager-lazy' {
  export const ConnectedPromptManagerLazy: React.ComponentType;
}

declare module '@brainstrike/app-shell/diagnostics' {
  export interface SettingsCategory {
    content: React.ReactNode;
    description?: string;
    icon?: LucideIcon;
    id: string;
    keywords?: string[];
    title: string;
  }

  export function createSystemDiagnosticsSettingsCategory(): SettingsCategory;
}

declare module '@brainstrike/app-shell/settings-page-content' {
  /**
   * See: packages/app-shell/src/settings-page-content.tsx
   */
  export interface SettingsCategory {
    content: React.ReactNode;
    description?: string;
    icon?: LucideIcon;
    id: string;
    keywords?: string[];
    title: string;
  }

  export interface SettingsPageContentProps {
    categories: SettingsCategory[];
    defaultCategoryId?: string;
    searchPlaceholder?: string;
  }

  export const SettingsPageContent: React.ComponentType<SettingsPageContentProps>;
  export function createAppearanceSettingsCategory(): SettingsCategory;
}

declare module '@brainstrike/app-shell' {
  /**
   * Re-exports from submodules for convenience.
   * See individual module declarations above for detailed type information.
   */
  export const navigationItems: unknown;
  export const RootLayoutContent: React.ComponentType;
  export interface SettingsCategory {
    content: React.ReactNode;
    description?: string;
    icon?: LucideIcon;
    id: string;
    keywords?: string[];
    title: string;
  }
  export interface SettingsPageContentProps {
    categories: SettingsCategory[];
    defaultCategoryId?: string;
    searchPlaceholder?: string;
  }
  export const SettingsPageContent: React.ComponentType<SettingsPageContentProps>;
  export function createAppearanceSettingsCategory(): SettingsCategory;
}
