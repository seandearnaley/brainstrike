/**
 * Types for the Unified Tools Settings UI
 */

import type {
  ConfiguredMcpServerId,
  McpExtensionEnablement,
  McpHostControlRequest,
  McpHostOperationResult,
  McpHostServerSnapshot,
  McpHostSnapshot,
  McpToolPreferencesFault,
} from '@brainstrike/assistant-contract';
import type { ToolCategory, ToolLoadingTier } from '@brainstrike/assistant-contract/tool-metadata';

/**
 * Minimal interface for token budget manager.
 * Matches the subset of TokenBudgetManager methods used by the tools settings UI.
 * This avoids importing the full @brainstrike/agent package which has server-only dependencies.
 */
export interface TokenBudgetManager {
  getConditionalToolsBudget: () => number;
  getContextResultsBudget: () => number;
  getCriticalToolsBudget: () => number;
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
  /**
   * Set when the saved MCP tool preferences exist but could not be read
   * (BST-1615). The tool list on screen is then a fail-closed default rather
   * than the user's choices, so the panel must say so instead of presenting it
   * as normal state. Platforms without persisted MCP preferences omit it.
   */
  preferencesFault?: McpToolPreferencesFault;
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
export type McpServerInfo = McpHostServerSnapshot;

/**
 * One connected server generation that user-initiated content browsing targets
 * (BST-1585). Mirrors the assistant-service content application port's
 * authority structurally; settings-ui depends only on assistant-contract.
 */
export interface McpContentAuthority {
  configuredServerId: ConfiguredMcpServerId;
  generation: number;
}
export interface McpReadResourceRequest {
  authority: McpContentAuthority;
  uri: string;
}
export interface McpGetPromptRequest {
  arguments?: Record<string, string>;
  authority: McpContentAuthority;
  name: string;
}
export interface McpCompleteRequest {
  argument: { name: string; value: string };
  authority: McpContentAuthority;
  context?: { arguments: Record<string, string> };
  ref: { name: string; type: 'ref/prompt' } | { type: 'ref/resource'; uri: string };
}
export type McpReadResourceResult = Extract<McpHostOperationResult, { type: 'resources/read' }>;
export type McpGetPromptResult = Extract<McpHostOperationResult, { type: 'prompts/get' }>;
export type McpCompleteResult = Extract<McpHostOperationResult, { type: 'completion/complete' }>;

/**
 * Operations for tool management.
 * Platform-specific implementations provide these callbacks.
 */
export interface ToolsSettingsOperations {
  /** Autocomplete one prompt or resource-template argument (desktop only, user-initiated). */
  completeMcpContent?: (request: McpCompleteRequest) => Promise<McpCompleteResult>;
  /** Connect, cancel, or retry one MCP server when the host exposes lifecycle control. */
  controlMcpServer?: (request: McpHostControlRequest) => Promise<McpHostServerSnapshot>;
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
  /** Read the global registered-extension dials (desktop only, BST-1604). */
  getMcpExtensionPreferences?: () => Promise<McpExtensionEnablement>;
  /** Fetch one prompt body for explicit user browsing (desktop only, never eager model context). */
  getMcpPrompt?: (request: McpGetPromptRequest) => Promise<McpGetPromptResult>;
  /**
   * Get status of MCP servers (desktop only).
   * Optional: Only required when mcpAvailable=true.
   */
  getMcpServerStatus?: () => Promise<McpHostSnapshot>;
  /** Get tool statistics */
  getStats: () => Promise<ToolStats>;
  /** Get all registered tools */
  getTools: () => Promise<ToolDisplayMetadata[]>;
  /** Open MCP config file selector */
  openMcpConfig?: () => Promise<void>;
  /** Read MCP config file text, optionally auto-creating it from a template */
  readMcpConfigText?: () => Promise<McpConfigTextDocument>;
  /** Read one resource body for explicit user browsing (desktop only, never eager model context). */
  readMcpResource?: (request: McpReadResourceRequest) => Promise<McpReadResourceResult>;
  /** Refresh MCP server connections */
  refreshMcpServers?: () => Promise<void>;
  /** Reset MCP config to default path */
  resetMcpConfig?: () => Promise<void>;
  /** Reset all tools to defaults */
  resetTools: () => Promise<void>;
  /** Set MCP config path (or reset to default when null) */
  setMcpConfigPath?: (configPath: string | null) => Promise<void>;
  /** Write the global registered-extension dials, resolving to the stored state (desktop only). */
  setMcpExtensionPreferences?: (
    preferences: McpExtensionEnablement
  ) => Promise<McpExtensionEnablement>;
  /** Subscribe to MCP config status changes (desktop only). */
  subscribeMcpConfig?: (listener: (info: McpConfigInfo) => void) => () => void;
  /** Subscribe to global registered-extension dial changes (desktop only). */
  subscribeMcpExtensionPreferences?: (
    listener: (preferences: McpExtensionEnablement) => void
  ) => () => void;
  /** Subscribe to revisioned MCP host status (desktop only). */
  subscribeMcpServerStatus?: (listener: (snapshot: McpHostSnapshot) => void) => () => void;
  /** Subscribe to MCP tool projection changes (desktop only). */
  subscribeMcpTools?: (listener: () => void) => () => void;
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
  /**
   * Optional host-owned execution seam for reusable/internal tool UIs. Product
   * settings surfaces omit it unless they have an explicitly authorized host
   * capability; the renderer Window bridge does not provide tool execution.
   */
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
