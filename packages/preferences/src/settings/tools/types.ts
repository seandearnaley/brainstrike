/**
 * Types for the Unified Tools Settings UI
 */

import type { ToolCategory, ToolLoadingTier } from '@brainstrike/agent/client';

/**
 * Minimal interface for token budget manager.
 * Matches the subset of TokenBudgetManager methods used by the tools settings UI.
 * This avoids importing the full @brainstrike/agent package which has server-only dependencies.
 */
export interface TokenBudgetManager {
  getCriticalToolsBudget(): number;
  getConditionalToolsBudget(): number;
  getContextResultsBudget(): number;
}

/**
 * Tool metadata for display in the UI.
 */
export interface ToolDisplayMetadata {
  id: string;
  source: 'native' | 'mcp';
  category: ToolCategory;
  loadingTier: ToolLoadingTier;
  description: string;
  enabled: boolean;
  serverName?: string;
  estimatedTokens: number;
  requiresApproval: boolean;
  inputSchema?: unknown;
}

/**
 * Tool statistics summary.
 */
export interface ToolStats {
  total: number;
  enabled: number;
  disabled: number;
  bySource: { native: number; mcp: number };
  byCategory: Record<ToolCategory, number>;
  mcpServers: number;
}

/**
 * Result of executing a tool test.
 */
export interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * MCP server connection information.
 */
export interface McpServerInfo {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  toolCount: number;
  error?: string;
}

/**
 * Operations for tool management.
 * Platform-specific implementations provide these callbacks.
 */
export interface ToolsSettingsOperations {
  /** Get all registered tools */
  getTools: () => Promise<ToolDisplayMetadata[]>;
  /** Get tool statistics */
  getStats: () => Promise<ToolStats>;
  /** Enable specific tools */
  enableTools: (toolIds: string[]) => Promise<void>;
  /** Disable specific tools */
  disableTools: (toolIds: string[]) => Promise<void>;
  /** Reset all tools to defaults */
  resetTools: () => Promise<void>;
  /** Enable all tools from a source */
  enableBySource?: (source: 'native' | 'mcp') => Promise<void>;
  /** Disable all tools from a source */
  disableBySource?: (source: 'native' | 'mcp') => Promise<void>;
  /** Execute a tool test (playground) */
  executeToolTest?: (toolId: string, input: unknown) => Promise<ToolExecutionResult>;
  /** Get MCP server status (desktop only) */
  getMcpServerStatus?: () => Promise<McpServerInfo[]>;
  /** Refresh MCP server connections */
  refreshMcpServers?: () => Promise<void>;
  /** Open MCP config file */
  openMcpConfig?: () => Promise<void>;
}

/**
 * Props for the unified tools settings component.
 */
export interface UnifiedToolsSettingsProps {
  /** Operations for managing tools */
  operations: ToolsSettingsOperations;
  /** Whether MCP tools are available (desktop only) */
  mcpAvailable?: boolean;
  /** Token budget manager for budget visualization */
  budgetManager?: TokenBudgetManager;
  /** Callback when tool state changes */
  onToolsChanged?: () => void;
}

/**
 * Props for the token budget summary component.
 */
export interface TokenBudgetSummaryProps {
  criticalTokens: number;
  conditionalTokens: number;
  totalBudget: number;
  contextWindowSize: number;
}

/**
 * Props for individual tool card.
 */
export interface ToolCardProps {
  tool: ToolDisplayMetadata;
  onToggle: (toolId: string, enabled: boolean) => Promise<void>;
  onExecuteTest?: ((toolId: string, input: unknown) => Promise<ToolExecutionResult>) | undefined;
  expanded?: boolean | undefined;
  onExpandChange?: ((expanded: boolean) => void) | undefined;
}

/**
 * Props for tool playground.
 */
export interface ToolPlaygroundProps {
  toolId: string;
  inputSchema?: unknown;
  onExecute: (input: unknown) => Promise<ToolExecutionResult>;
}

/**
 * Props for tools filter bar.
 */
export interface ToolsFilterBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  categoryFilter: ToolCategory | 'all';
  onCategoryChange: (category: ToolCategory | 'all') => void;
  tierFilter: ToolLoadingTier | 'all';
  onTierChange: (tier: ToolLoadingTier | 'all') => void;
  onReset: () => void;
}

/**
 * Props for MCP server status section.
 */
export interface McpServerStatusProps {
  servers: McpServerInfo[];
  onRefresh: () => Promise<void>;
  onOpenConfig?: (() => Promise<void>) | undefined;
  onEnableServer: (serverName: string) => Promise<void>;
  onDisableServer: (serverName: string) => Promise<void>;
  loading?: boolean | undefined;
}

/**
 * Grouped tools by source/server.
 */
export interface ToolGroup {
  id: string;
  label: string;
  source: 'native' | 'mcp';
  serverName?: string;
  tools: ToolDisplayMetadata[];
  enabledCount: number;
}
