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

import type { LogSourceAdapter } from '@brainstrike/settings-ui/settings/system/logging-settings-section';
import type { LucideIcon } from 'lucide-react';
import type React from 'react';

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
    changesPageContent?: React.ReactNode;
    databaseTabChunkingMode?: 'host-proxy' | 'local';
    gitPageContent?: React.ReactNode;
    loadEmbeddingQueue?: (() => Promise<unknown>) | null;
    navigationItems: unknown[];
    preloadDatabaseTabOnMount?: boolean;
    settingsPageContent: React.ReactNode;
  }
}

declare module '@brainstrike/app-shell/changes' {
  /** The Changes surface (BST-1114): header + changed-files tree + diff pane. */
  export const ChangesSurface: React.ComponentType;
  /** True when the desktop `window.changes` bridge is present and fully formed. */
  export function isChangesBridgeAvailable(): boolean;
}

// NOTE: no shims for the `/changes/availability`, `/git-panel/availability`,
// and `/terminal-panel/availability` subpaths — tsconfig `paths` pins them to
// real app-shell source (an ambient declaration here would shadow that pin and
// hide the true export surface, e.g. the *_BRIDGE_REQUIRED_METHODS constants).

declare module '@brainstrike/app-shell/git-panel' {
  export const GitPanel: React.ComponentType;
  /** True when the desktop `window.git` bridge is present and fully formed. */
  export function isGitBridgeAvailable(): boolean;
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

  /**
   * See: packages/app-shell/src/diagnostics/diagnostic-sink-bridge.tsx
   */
  export interface DiagnosticSinkBridgeProps {
    flushBatchSize?: number;
    source: string;
  }

  export const DiagnosticSinkBridge: React.ComponentType<DiagnosticSinkBridgeProps>;
  export const DIAGNOSTIC_SINK_SCOPE: string;
  export function getDiagnosticSessionId(): string;

  /**
   * See: packages/app-shell/src/diagnostics/durable-log-source.ts
   */
  export interface DurableLogExportResult {
    exportedCount: number;
    ndjson: string;
    totalCount: number;
    truncated: boolean;
  }

  export type DurableLogSource = LogSourceAdapter & {
    exportNdjson(): Promise<DurableLogExportResult>;
  };

  /**
   * See: packages/app-shell/src/diagnostics/use-durable-log-source.ts
   */
  export function useDurableLogSource(): DurableLogSource | undefined;
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
