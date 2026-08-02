/**
 * Tools Settings Category Factory
 *
 * Creates a SettingsCategory for managing agent tools (native and MCP).
 */

import { Wrench } from 'lucide-react';
import type { SettingsCategory } from '../../settings-page-content';
import type {
  TokenBudgetManager,
  ToolDisplayMetadata,
  ToolStats,
  ToolsSettingsOperations,
} from './types';
import { UnifiedToolsSettings } from './unified-tools-settings';

/**
 * Options for creating the tools settings category.
 */
export interface CreateToolsSettingsCategoryOptions {
  /**
   * Token budget manager for budget visualization.
   */
  budgetManager?: TokenBudgetManager;

  /**
   * Whether MCP tools are available.
   * MCP is typically only available on desktop.
   * @default false
   */
  mcpAvailable?: boolean;

  /**
   * Callback when tool state changes.
   * Use this to sync with persisted preferences.
   */
  onToolsChanged?: () => void;
  /**
   * Operations for managing tools.
   * Platform-specific implementations provide these callbacks.
   */
  operations: ToolsSettingsOperations;
}

/**
 * Creates a SettingsCategory for managing agent tools.
 *
 * @example
 * ```tsx
 * // Web app - native tools only (operations supplied by the host)
 * const toolsCategory = createToolsSettingsCategory({
 *   operations: {
 *     getTools: async () => listNativeTools(),
 *     getStats: async () => getNativeToolStats(),
 *     enableTools: async (ids) => enableNativeTools(ids),
 *     disableTools: async (ids) => disableNativeTools(ids),
 *     resetTools: async () => resetNativeTools(),
 *   },
 * });
 *
 * // Desktop app - with MCP support
 * const toolsCategory = createToolsSettingsCategory({
 *   operations: {
 *     getTools: async () => window.tools.list(),
 *     getStats: async () => window.tools.getStats(),
 *     enableTools: async (ids) => window.tools.enable(ids),
 *     disableTools: async (ids) => window.tools.disable(ids),
 *     resetTools: async () => window.tools.reset(),
 *     enableBySource: async (source) => window.tools.enableBySource(source),
 *     disableBySource: async (source) => window.tools.disableBySource(source),
 *     executeToolTest: async (id, input) => window.tools.execute(id, input),
 *     getMcpServerStatus: async () => window.mcp.getServerStatus(),
 *   },
 *   mcpAvailable: true,
 *   onToolsChanged: () => saveToolPreferences(),
 * });
 * ```
 */
export function createToolsSettingsCategory(
  options: CreateToolsSettingsCategoryOptions
): SettingsCategory {
  const { operations, mcpAvailable = false, budgetManager, onToolsChanged } = options;

  return {
    content: (
      <UnifiedToolsSettings
        mcpAvailable={mcpAvailable}
        operations={operations}
        {...(budgetManager !== undefined && { budgetManager })}
        {...(onToolsChanged !== undefined && { onToolsChanged })}
      />
    ),
    description: 'Configure which tools are available to the AI agent.',
    icon: Wrench,
    id: 'ai-tools',
    keywords: [
      'tools',
      'agent',
      'mcp',
      'native',
      'retrieval',
      'search',
      'hybrid',
      'embedding',
      'queue',
      'playground',
    ],
    title: 'AI Tools',
  };
}

export type { McpConfigAlertProps } from './mcp-config-alert';
export { McpConfigAlert } from './mcp-config-alert';
export { TokenBudgetSummary } from './token-budget-summary';
/**
 * Tool Card
 *
 * @deprecated Use ToolRow for dense display, ToolRowExpanded for details.
 * This component will be removed in a future version.
 */
export { ToolCard } from './tool-card';
export type { McpConnectionStatus, ToolGroupAccordionProps } from './tool-group-accordion';
export { ToolGroupAccordion } from './tool-group-accordion';
export { ToolPlayground } from './tool-playground';
export type { ToolRowProps } from './tool-row';
export { ToolRow } from './tool-row';
export type { ToolRowExpandedProps } from './tool-row-expanded';
export { ToolRowExpanded } from './tool-row-expanded';
export { ToolsFilterBar } from './tools-filter-bar';
export type {
  McpConfigInfo,
  McpConfigTextDocument,
  McpServerInfo,
  McpServerStatusProps,
  TokenBudgetSummaryProps,
  ToolCardProps,
  ToolExecutionResult,
  ToolGroup,
  ToolPlaygroundProps,
  ToolsFilterBarProps,
  ToolsLiveQueryConfig,
  UnifiedToolsSettingsProps,
} from './types';
// Re-export components
export { UnifiedToolsSettings } from './unified-tools-settings';
// Re-export types
export type { ToolDisplayMetadata, ToolStats, ToolsSettingsOperations };
