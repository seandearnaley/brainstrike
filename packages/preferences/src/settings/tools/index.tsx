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
   * Operations for managing tools.
   * Platform-specific implementations provide these callbacks.
   */
  operations: ToolsSettingsOperations;

  /**
   * Whether MCP tools are available.
   * MCP is typically only available on desktop.
   * @default false
   */
  mcpAvailable?: boolean;

  /**
   * Token budget manager for budget visualization.
   */
  budgetManager?: TokenBudgetManager;

  /**
   * Callback when tool state changes.
   * Use this to sync with persisted preferences.
   */
  onToolsChanged?: () => void;
}

/**
 * Creates a SettingsCategory for managing agent tools.
 *
 * @example
 * ```tsx
 * // Web app - native tools only
 * const toolsCategory = createToolsSettingsCategory({
 *   operations: {
 *     getTools: async () => unifiedToolRegistry.getAllTools(),
 *     getStats: async () => unifiedToolRegistry.getStats(),
 *     enableTools: async (ids) => unifiedToolRegistry.enableTools(ids),
 *     disableTools: async (ids) => unifiedToolRegistry.disableTools(ids),
 *     resetTools: async () => unifiedToolRegistry.reset(),
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
 *   budgetManager: createBudgetManagerForTier('large'),
 *   onToolsChanged: () => saveToolPreferences(),
 * });
 * ```
 */
export function createToolsSettingsCategory(
  options: CreateToolsSettingsCategoryOptions
): SettingsCategory {
  const { operations, mcpAvailable = false, budgetManager, onToolsChanged } = options;

  return {
    id: 'ai-tools',
    title: 'AI Tools',
    description: 'Configure which tools are available to the AI agent.',
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
    icon: Wrench,
    render: () => (
      <UnifiedToolsSettings
        mcpAvailable={mcpAvailable}
        operations={operations}
        {...(budgetManager !== undefined && { budgetManager })}
        {...(onToolsChanged !== undefined && { onToolsChanged })}
      />
    ),
  };
}

// Re-export types
export type { ToolsSettingsOperations, ToolStats, ToolDisplayMetadata };
export { McpServerStatus } from './mcp-server-status';
export { TokenBudgetSummary } from './token-budget-summary';
export { ToolCard } from './tool-card';
export { ToolPlayground } from './tool-playground';
export { ToolsFilterBar } from './tools-filter-bar';
export type {
  McpServerInfo,
  McpServerStatusProps,
  TokenBudgetSummaryProps,
  ToolCardProps,
  ToolExecutionResult,
  ToolGroup,
  ToolPlaygroundProps,
  ToolsFilterBarProps,
  UnifiedToolsSettingsProps,
} from './types';
// Re-export components
export { UnifiedToolsSettings } from './unified-tools-settings';
