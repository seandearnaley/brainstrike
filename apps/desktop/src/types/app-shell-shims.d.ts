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

declare module '@brainstrike/app-shell/navigation' {
  export const navigationItems: unknown;
}

declare module '@brainstrike/app-shell/root-layout-content' {
  export const RootLayoutContent: React.ComponentType;
}

declare module '@brainstrike/app-shell/settings-page-content' {
  /**
   * See: packages/app-shell/src/settings-page-content.tsx
   */
  export interface SettingsCategory {
    description?: string;
    icon?: React.ComponentType<{ className?: string }>;
    id: string;
    keywords?: string[];
    render: () => React.ReactNode;
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
    description?: string;
    icon?: React.ComponentType<{ className?: string }>;
    id: string;
    keywords?: string[];
    render: () => React.ReactNode;
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
