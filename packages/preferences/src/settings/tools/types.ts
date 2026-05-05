/**
 * Types for the Unified Tools Settings UI
 */

import type { ToolCategory, ToolLoadingTier } from '@brainstrike/agent/tool-metadata';

/**
 * Minimal interface for token budget manager.
 * Matches the subset of TokenBudgetManager methods used by the tools settings UI.
 * This avoids importing the full @brainstrike/agent package which has server-only dependencies.
 */
export interface TokenBudgetManager {
  getConditionalToolsBudget(): number;
  getContextResultsBudget(): number;
  getCriticalToolsBudget(): number;
}

/**
 * Tool metadata for display in the UI.
 */
export interface ToolDisplayMetadata {
  category: ToolCategory;
  description: string;
  enabled: boolean;
  estimatedTokens: number;
  id: string;
  inputSchema?: unknown;
  loadingTier: ToolLoadingTier;
  requiresApproval: boolean;
  serverName?: string;
  source: 'native' | 'mcp';
}

/**
 * Tool statistics summary.
 */
export interface ToolStats {
  byCategory: Record<ToolCategory, number>;
  bySource: { native: number; mcp: number };
  disabled: number;
  enabled: number;
  mcpServers: number;
  total: number;
}

interface BaseToolsLiveQueryConfig {
  /** Parameters for the SQL query */
  params?: readonly unknown[];
  /** SQL query that returns ToolDisplayMetadata rows */
  query: string;
  /** Optional selector to transform or filter live rows */
  select?: (rows: ToolDisplayMetadata[]) => ToolDisplayMetadata[];
}

/**
 * Configuration for live tool queries via PGlite.
 */
export type ToolsLiveQueryConfig =
  | (BaseToolsLiveQueryConfig & {
      key?: never;
      mode?: 'query';
    })
  | (BaseToolsLiveQueryConfig & {
      /** Stable row identity column required by PGlite incremental live queries */
      key: string;
      mode: 'incremental';
    });

/**
 * Result of executing a tool test.
 */
export type ToolExecutionResult<T = unknown> =
  | {
      success: true;
      result: T;
      durationMs: number;
    }
  | {
      success: false;
      error: string;
      durationMs: number;
    };

/**
 * MCP server connection information.
 */
export interface McpServerInfo {
  error?: string;
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  toolCount: number;
}

/**
 * Operations for tool management.
 * Platform-specific implementations provide these callbacks.
 */
export interface ToolsSettingsOperations {
  /** Create a sample MCP config file */
  createSampleConfig?: () => Promise<{ success: boolean; path: string; error?: string }>;
  /** Disable all tools from a source */
  disableBySource?: (source: 'native' | 'mcp') => Promise<void>;
  /** Disable specific tools */
  disableTools: (toolIds: string[]) => Promise<void>;
  /** Enable all tools from a source */
  enableBySource?: (source: 'native' | 'mcp') => Promise<void>;
  /** Enable specific tools */
  enableTools: (toolIds: string[]) => Promise<void>;
  /** Execute a tool test (playground) */
  executeToolTest?: (toolId: string, input: unknown) => Promise<ToolExecutionResult>;
  /** Get current MCP config info */
  getMcpConfigInfo?: () => Promise<McpConfigInfo | null>;
  /** Get current MCP config path */
  getMcpConfigPath?: () => Promise<string>;
  /**
   * Get status of MCP servers (desktop only).
   * Optional: Only required when mcpAvailable=true.
   */
  getMcpServerStatus?: () => Promise<McpServerInfo[]>;
  /** Get tool statistics */
  getStats: () => Promise<ToolStats>;
  /** Get all registered tools */
  getTools: () => Promise<ToolDisplayMetadata[]>;
  /** Open MCP config file selector */
  openMcpConfig?: () => Promise<void>;
  /** Read MCP config file text, optionally auto-creating it from a template */
  readMcpConfigText?: () => Promise<McpConfigTextDocument>;
  /** Refresh MCP server connections */
  refreshMcpServers?: () => Promise<void>;
  /** Reset MCP config to default path */
  resetMcpConfig?: () => Promise<void>;
  /** Reset all tools to defaults */
  resetTools: () => Promise<void>;
  /** Set MCP config path (or reset to default when null) */
  setMcpConfigPath?: (configPath: string | null) => Promise<void>;
  /** Optional live query configuration for tools (PGlite) */
  toolsLiveQuery?: ToolsLiveQueryConfig;
  /** Validate and write MCP config file text */
  writeMcpConfigText?: (
    content: string
  ) => Promise<{ success: true; path: string } | { success: false; path: string; error: string }>;
}

/**
 * Props for the unified tools settings component.
 */
export interface UnifiedToolsSettingsProps {
  /** Token budget manager for budget visualization */
  budgetManager?: TokenBudgetManager;
  /** Whether MCP tools are available (desktop only) */
  mcpAvailable?: boolean;
  /** Callback when tool state changes */
  onToolsChanged?: () => void;
  /** Operations for managing tools */
  operations: ToolsSettingsOperations;
}

/**
 * Props for the token budget summary component.
 */
export interface TokenBudgetSummaryProps {
  conditionalTokens: number;
  contextWindowSize: number;
  criticalTokens: number;
  totalBudget: number;
}

/**
 * Props for individual tool card.
 */
export interface ToolCardProps {
  expanded?: boolean | undefined;
  onExecuteTest?: ((toolId: string, input: unknown) => Promise<ToolExecutionResult>) | undefined;
  onExpandChange?: ((expanded: boolean) => void) | undefined;
  onToggle: (toolId: string, enabled: boolean) => Promise<void>;
  tool: ToolDisplayMetadata;
}

/**
 * Props for tool playground.
 */
export interface ToolPlaygroundProps {
  inputSchema?: unknown;
  onExecute: (input: unknown) => Promise<ToolExecutionResult>;
  toolId: string;
}

/**
 * Props for tools filter bar.
 */
export interface ToolsFilterBarProps {
  categoryFilter: ToolCategory | 'all';
  onCategoryChange: (category: ToolCategory | 'all') => void;
  onReset: () => void;
  onSearchChange: (query: string) => void;
  onTierChange: (tier: ToolLoadingTier | 'all') => void;
  searchQuery: string;
  tierFilter: ToolLoadingTier | 'all';
  /** Total tool count for display */
  totalCount?: number;
}

/**
 * MCP config information for display.
 */
export interface McpConfigInfo {
  /** Optional config load or parse error */
  error?: string;
  /** Whether the config file exists */
  exists: boolean;
  /** Current config file path */
  path: string;
}

export interface McpConfigTextDocument {
  content: string;
  created: boolean;
  exists: boolean;
  path: string;
}

/**
 * Props for MCP server status section.
 */
export interface McpServerStatusProps {
  /** Config info to display (desktop only) */
  configInfo?: McpConfigInfo | undefined;
  loading?: boolean | undefined;
  onDisableServer: (serverName: string) => Promise<void>;
  onEnableServer: (serverName: string) => Promise<void>;
  onOpenConfig?: (() => Promise<void>) | undefined;
  onRefresh: () => Promise<void>;
  onResetConfig?: (() => Promise<void>) | undefined;
  servers: McpServerInfo[];
}

/**
 * Grouped tools by source/server.
 */
export interface ToolGroup {
  enabledCount: number;
  id: string;
  label: string;
  serverName?: string;
  source: 'native' | 'mcp';
  tools: ToolDisplayMetadata[];
}
