import { Wrench } from 'lucide-react';
import { createElement } from 'react';
import type { SettingsCategory } from '../../settings-page-content';
import type { TokenBudgetManager, ToolsSettingsOperations } from './types';
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
 */
export function createToolsSettingsCategory(
  options: CreateToolsSettingsCategoryOptions
): SettingsCategory {
  const { operations, mcpAvailable = false, budgetManager, onToolsChanged } = options;

  return {
    content: createElement(UnifiedToolsSettings, {
      mcpAvailable,
      operations,
      ...(budgetManager === undefined ? {} : { budgetManager }),
      ...(onToolsChanged === undefined ? {} : { onToolsChanged }),
    }),
    description: 'Configure which tools are available to the AI agent.',
    icon: Wrench,
    id: 'ai-tools',
    keywords: [
      'tools',
      'agent',
      'mcp',
      'native',
      'search',
      'queue',
      'mcp servers',
      'mcp config',
      'mcp catalog',
      'mcp extensions',
      'tool playground',
      'token budget',
    ],
    title: 'AI Tools',
  };
}
