import type React from 'react';

declare module '@brainstrike/app-shell/navigation' {
  export const navigationItems: unknown;
}

declare module '@brainstrike/app-shell/root-layout-content' {
  export const RootLayoutContent: React.ComponentType;
}

declare module '@brainstrike/app-shell/settings-page-content' {
  export interface SettingsCategory {
    id: string;
    title: string;
    description?: string;
    keywords?: string[];
    icon?: React.ComponentType<{ className?: string }>;
    render: () => React.ReactNode;
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
  export const navigationItems: unknown;
  export const RootLayoutContent: React.ComponentType;
  export interface SettingsCategory {
    id: string;
    title: string;
    description?: string;
    keywords?: string[];
    icon?: React.ComponentType<{ className?: string }>;
    render: () => React.ReactNode;
  }
  export interface SettingsPageContentProps {
    categories: SettingsCategory[];
    defaultCategoryId?: string;
    searchPlaceholder?: string;
  }
  export const SettingsPageContent: React.ComponentType<SettingsPageContentProps>;
  export function createAppearanceSettingsCategory(): SettingsCategory;
}
