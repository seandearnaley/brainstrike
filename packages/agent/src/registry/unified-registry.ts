/**
 * Unified Tool Registry
 *
 * Combines native BrainStrike tools with MCP tools into a single registry,
 * providing a unified interface for:
 * - Tool discovery and registration
 * - Enable/disable state management
 * - Category-based filtering and organization
 * - Three-tier loading with token budget awareness
 *
 * @see tool-categories.ts for category and tier definitions
 */

import { createLogger } from '@brainstrike/utils';
import type { ToolsInput } from '@mastra/core/agent';
import {
  compareByLoadPriority,
  getNativeToolDefaults,
  type ToolCategory,
  type ToolLoadingTier,
  type ToolSource,
} from './tool-categories';

const logger = createLogger('UnifiedToolRegistry');

/**
 * Unified tool metadata that supports both native and MCP tools.
 */
export interface UnifiedToolMetadata {
  /** Unique identifier following namespace.toolName pattern */
  id: string;
  /** Source of the tool: native (built-in) or mcp (from MCP server) */
  source: ToolSource;
  /** Functional category for organization and priority */
  category: ToolCategory;
  /** Loading tier determining when the tool is loaded */
  loadingTier: ToolLoadingTier;
  /** Human-readable description */
  description: string;
  /** Zod schema or JSON schema for tool input */
  inputSchema?: unknown;
  /** Whether the tool is enabled for use */
  enabled: boolean;
  /** Timestamp when the tool was discovered/registered */
  discoveredAt: number;
  /** MCP server name (only for MCP tools) */
  serverName?: string;
  /** Estimated token count for tool schema in context */
  estimatedTokens: number;
  /** Whether this tool requires user approval before execution */
  requiresApproval: boolean;
}

/**
 * Options for registering a native tool.
 */
export interface NativeToolRegistrationOptions {
  id: string;
  description: string;
  inputSchema?: unknown;
  category?: ToolCategory;
  loadingTier?: ToolLoadingTier;
  estimatedTokens?: number;
  requiresApproval?: boolean;
  enabled?: boolean;
}

/**
 * Options for registering MCP tools from a server.
 */
export interface McpToolRegistrationOptions {
  serverName: string;
  tools: ToolsInput;
  /** Optional: override category for all tools from this server */
  categoryOverride?: ToolCategory;
  /** Optional: override tier for all tools from this server */
  tierOverride?: ToolLoadingTier;
}

/**
 * Tools grouped by category for UI display.
 */
export interface ToolsByCategory {
  [category: string]: UnifiedToolMetadata[];
}

/**
 * Tools grouped by source and server.
 */
export interface ToolsBySource {
  native: UnifiedToolMetadata[];
  mcp: {
    [serverName: string]: UnifiedToolMetadata[];
  };
}

/**
 * Filter configuration for retrieving tools.
 */
export interface ToolFilterConfig {
  /** Filter by source type */
  source?: ToolSource;
  /** Filter by category */
  category?: ToolCategory;
  /** Filter by loading tier */
  loadingTier?: ToolLoadingTier;
  /** Filter by enabled state */
  enabled?: boolean;
  /** Filter by approval requirement */
  requiresApproval?: boolean;
  /** Only include tools matching these patterns */
  patterns?: string[];
  /** Exclude tools matching these patterns */
  excludePatterns?: string[];
}

/**
 * Statistics about registered tools.
 */
export interface ToolRegistryStats {
  total: number;
  enabled: number;
  disabled: number;
  bySource: {
    native: number;
    mcp: number;
  };
  byCategory: Record<ToolCategory, number>;
  byTier: Record<ToolLoadingTier, number>;
  mcpServers: number;
}

/**
 * Listener function for registry state changes.
 */
export type ToolRegistryListener = (tools: UnifiedToolMetadata[]) => void;

/**
 * Default estimated tokens for MCP tools without explicit specification.
 */
const DEFAULT_MCP_TOOL_TOKENS = 100;

/**
 * Default category for MCP tools that don't have explicit categorization.
 */
const DEFAULT_MCP_CATEGORY: ToolCategory = 'action';

/**
 * Default loading tier for MCP tools.
 */
const DEFAULT_MCP_TIER: ToolLoadingTier = 'conditional';

/**
 * Unified Tool Registry
 *
 * Central registry for managing all agent tools (native and MCP).
 */
export class UnifiedToolRegistry {
  private readonly tools: Map<string, UnifiedToolMetadata> = new Map();
  private readonly toolsByServer: Map<string, Set<string>> = new Map();
  private readonly listeners: ToolRegistryListener[] = [];
  private readonly listenerErrors: Map<ToolRegistryListener, number> = new Map();
  private readonly maxListenerErrors = 3;

  /**
   * Register a native tool.
   */
  registerNativeTool(options: NativeToolRegistrationOptions): void {
    this.registerNativeToolInternal(options);
    logger.debug('Native tool registered', {
      id: options.id,
      category: options.category ?? getNativeToolDefaults(options.id)?.category ?? 'action',
      loadingTier:
        options.loadingTier ?? getNativeToolDefaults(options.id)?.loadingTier ?? 'conditional',
    });
    this.notifyListeners();
  }

  /**
   * Register multiple native tools at once.
   */
  registerNativeTools(tools: NativeToolRegistrationOptions[]): void {
    for (const tool of tools) {
      this.registerNativeToolInternal(tool);
    }
    logger.info('Native tools registered', { count: tools.length });
    this.notifyListeners();
  }

  /**
   * Register tools from an MCP server.
   */
  registerMcpTools(options: McpToolRegistrationOptions): void {
    const { serverName, tools, categoryOverride, tierOverride } = options;
    const previousToolIds = this.toolsByServer.get(serverName);
    const toolIds = new Set<string>();
    const discoveredAt = Date.now();

    for (const [toolId, tool] of Object.entries(tools)) {
      const existing = this.tools.get(toolId);

      // Extract description and schema from tool object
      const description = this.extractDescription(tool);
      const inputSchema = this.extractInputSchema(tool);

      // Check if this MCP tool has native defaults (hybrid tool)
      const nativeDefaults = getNativeToolDefaults(toolId);

      const metadata: UnifiedToolMetadata = {
        id: toolId,
        source: 'mcp',
        category: categoryOverride ?? nativeDefaults?.category ?? DEFAULT_MCP_CATEGORY,
        loadingTier: tierOverride ?? nativeDefaults?.loadingTier ?? DEFAULT_MCP_TIER,
        description,
        inputSchema,
        enabled: existing?.enabled ?? true,
        discoveredAt: existing?.discoveredAt ?? discoveredAt,
        serverName,
        estimatedTokens: nativeDefaults?.estimatedTokens ?? DEFAULT_MCP_TOOL_TOKENS,
        requiresApproval: nativeDefaults?.requiresApproval ?? false,
      };

      this.tools.set(toolId, metadata);
      toolIds.add(toolId);
    }

    if (previousToolIds) {
      for (const id of previousToolIds) {
        if (toolIds.has(id)) {
          continue;
        }
        const existing = this.tools.get(id);
        if (existing?.serverName === serverName) {
          this.tools.delete(id);
        }
      }
    }

    this.toolsByServer.set(serverName, toolIds);

    logger.info('MCP tools registered', {
      serverName,
      count: toolIds.size,
      enabled: Array.from(toolIds).filter((id) => this.tools.get(id)?.enabled).length,
    });

    this.notifyListeners();
  }

  /**
   * Get a single tool by ID.
   */
  getTool(id: string): UnifiedToolMetadata | undefined {
    return this.tools.get(id);
  }

  /**
   * Get all registered tools as an array.
   */
  getAllTools(): UnifiedToolMetadata[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools matching a filter configuration.
   */
  getFilteredTools(filter: ToolFilterConfig): UnifiedToolMetadata[] {
    let tools = this.getAllTools();

    if (filter.source !== undefined) {
      tools = tools.filter((t) => t.source === filter.source);
    }

    if (filter.category !== undefined) {
      tools = tools.filter((t) => t.category === filter.category);
    }

    if (filter.loadingTier !== undefined) {
      tools = tools.filter((t) => t.loadingTier === filter.loadingTier);
    }

    if (filter.enabled !== undefined) {
      tools = tools.filter((t) => t.enabled === filter.enabled);
    }

    if (filter.requiresApproval !== undefined) {
      tools = tools.filter((t) => t.requiresApproval === filter.requiresApproval);
    }

    if (filter.patterns && filter.patterns.length > 0) {
      tools = tools.filter((t) =>
        filter.patterns?.some((pattern) => this.matchPattern(t.id, pattern))
      );
    }

    if (filter.excludePatterns && filter.excludePatterns.length > 0) {
      tools = tools.filter(
        (t) => !filter.excludePatterns?.some((pattern) => this.matchPattern(t.id, pattern))
      );
    }

    return tools;
  }

  /**
   * Get enabled tools suitable for agent runtime.
   */
  getEnabledTools(): UnifiedToolMetadata[] {
    return this.getFilteredTools({ enabled: true });
  }

  /**
   * Get tools by category, sorted by load priority.
   */
  getToolsByCategory(): ToolsByCategory {
    const result: ToolsByCategory = {};

    for (const tool of this.getAllTools()) {
      const categoryTools = result[tool.category];
      if (categoryTools) {
        categoryTools.push(tool);
      } else {
        result[tool.category] = [tool];
      }
    }

    // Sort each category by load priority
    for (const category of Object.keys(result)) {
      const categoryTools = result[category];
      if (categoryTools) {
        categoryTools.sort(compareByLoadPriority);
      }
    }

    return result;
  }

  /**
   * Get tools grouped by source (native vs MCP servers).
   */
  getToolsBySource(): ToolsBySource {
    const result: ToolsBySource = {
      native: [],
      mcp: {},
    };

    for (const tool of this.getAllTools()) {
      if (tool.source === 'native') {
        result.native.push(tool);
      } else if (tool.serverName) {
        const serverTools = result.mcp[tool.serverName];
        if (serverTools) {
          serverTools.push(tool);
        } else {
          result.mcp[tool.serverName] = [tool];
        }
      }
    }

    return result;
  }

  /**
   * Get tools from a specific MCP server.
   */
  getToolsForServer(serverName: string): UnifiedToolMetadata[] {
    const toolIds = this.toolsByServer.get(serverName);
    if (!toolIds) {
      return [];
    }

    return Array.from(toolIds)
      .map((id) => this.tools.get(id))
      .filter((tool): tool is UnifiedToolMetadata => tool !== undefined);
  }

  /**
   * Get tools by loading tier.
   */
  getToolsByTier(tier: ToolLoadingTier): UnifiedToolMetadata[] {
    return this.getFilteredTools({ loadingTier: tier, enabled: true });
  }

  /**
   * Get critical tools (always loaded).
   */
  getCriticalTools(): UnifiedToolMetadata[] {
    return this.getToolsByTier('critical');
  }

  /**
   * Get conditional tools (budget-aware loading).
   */
  getConditionalTools(): UnifiedToolMetadata[] {
    return this.getToolsByTier('conditional');
  }

  /**
   * Get deferred tools (on-demand loading).
   */
  getDeferredTools(): UnifiedToolMetadata[] {
    return this.getToolsByTier('deferred');
  }

  /**
   * Enable specific tool(s).
   */
  enableTools(toolIds: string[]): void {
    let changed = false;
    for (const id of toolIds) {
      const tool = this.tools.get(id);
      if (tool && !tool.enabled) {
        tool.enabled = true;
        this.tools.set(id, tool);
        changed = true;
      }
    }

    if (changed) {
      logger.info('Tools enabled', { count: toolIds.length, toolIds });
      this.notifyListeners();
    }
  }

  /**
   * Disable specific tool(s).
   */
  disableTools(toolIds: string[]): void {
    let changed = false;
    for (const id of toolIds) {
      const tool = this.tools.get(id);
      if (tool?.enabled) {
        tool.enabled = false;
        this.tools.set(id, tool);
        changed = true;
      }
    }

    if (changed) {
      logger.info('Tools disabled', { count: toolIds.length, toolIds });
      this.notifyListeners();
    }
  }

  /**
   * Toggle the enabled state of a tool.
   */
  toggleTool(toolId: string): boolean {
    const tool = this.tools.get(toolId);
    if (!tool) {
      return false;
    }

    tool.enabled = !tool.enabled;
    this.tools.set(toolId, tool);
    this.notifyListeners();
    return tool.enabled;
  }

  /**
   * Enable all tools from a specific source.
   */
  enableBySource(source: ToolSource): void {
    const toolIds = this.getFilteredTools({ source }).map((t) => t.id);
    this.enableTools(toolIds);
  }

  /**
   * Disable all tools from a specific source.
   */
  disableBySource(source: ToolSource): void {
    const toolIds = this.getFilteredTools({ source }).map((t) => t.id);
    this.disableTools(toolIds);
  }

  /**
   * Enable all tools from a specific MCP server.
   */
  enableServerTools(serverName: string): void {
    const toolIds = this.toolsByServer.get(serverName);
    if (toolIds) {
      this.enableTools(Array.from(toolIds));
    }
  }

  /**
   * Disable all tools from a specific MCP server.
   */
  disableServerTools(serverName: string): void {
    const toolIds = this.toolsByServer.get(serverName);
    if (toolIds) {
      this.disableTools(Array.from(toolIds));
    }
  }

  /**
   * Filter a ToolsInput object to only include enabled tools.
   */
  filterEnabledTools(originalTools: ToolsInput): ToolsInput {
    const filtered: ToolsInput = {};

    for (const [id, tool] of Object.entries(originalTools)) {
      const metadata = this.tools.get(id);
      // Include if not registered (unknown tools pass through) or if enabled
      if (!metadata || metadata.enabled) {
        filtered[id] = tool;
      }
    }

    return filtered;
  }

  /**
   * Get registry statistics.
   */
  getStats(): ToolRegistryStats {
    const tools = this.getAllTools();
    const mcpServers = new Set<string>();

    const stats: ToolRegistryStats = {
      total: tools.length,
      enabled: 0,
      disabled: 0,
      bySource: { native: 0, mcp: 0 },
      byCategory: {
        retrieval: 0,
        action: 0,
        analysis: 0,
        configuration: 0,
        validation: 0,
      },
      byTier: {
        critical: 0,
        conditional: 0,
        deferred: 0,
      },
      mcpServers: 0,
    };

    for (const tool of tools) {
      if (tool.enabled) {
        stats.enabled++;
      } else {
        stats.disabled++;
      }

      stats.bySource[tool.source]++;
      stats.byCategory[tool.category]++;
      stats.byTier[tool.loadingTier]++;

      if (tool.serverName) {
        mcpServers.add(tool.serverName);
      }
    }

    stats.mcpServers = mcpServers.size;
    return stats;
  }

  /**
   * Calculate total estimated tokens for enabled tools.
   */
  getTotalEstimatedTokens(filter?: ToolFilterConfig): number {
    const tools = filter ? this.getFilteredTools(filter) : this.getEnabledTools();
    return tools.reduce((sum, tool) => sum + tool.estimatedTokens, 0);
  }

  /**
   * Subscribe to registry state changes.
   */
  subscribe(listener: ToolRegistryListener): () => void {
    this.listeners.push(listener);
    this.listenerErrors.delete(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
      this.listenerErrors.delete(listener);
    };
  }

  /**
   * Clear all registered tools.
   */
  clear(): void {
    this.tools.clear();
    this.toolsByServer.clear();
    logger.info('Registry cleared');
    this.notifyListeners();
  }

  /**
   * Clear tools from a specific MCP server.
   */
  clearServer(serverName: string): void {
    const toolIds = this.toolsByServer.get(serverName);
    if (!toolIds) {
      return;
    }

    for (const id of toolIds) {
      this.tools.delete(id);
    }
    this.toolsByServer.delete(serverName);

    logger.info('Server tools cleared', { serverName, count: toolIds.size });
    this.notifyListeners();
  }

  /**
   * Export current enabled/disabled state for persistence.
   */
  exportState(): Record<string, boolean> {
    const state: Record<string, boolean> = {};
    for (const [id, tool] of this.tools.entries()) {
      state[id] = tool.enabled;
    }
    return state;
  }

  /**
   * Import enabled/disabled state from persistence.
   */
  importState(state: Record<string, boolean>): void {
    let changed = false;
    for (const [id, enabled] of Object.entries(state)) {
      const tool = this.tools.get(id);
      if (tool && tool.enabled !== enabled) {
        tool.enabled = enabled;
        this.tools.set(id, tool);
        changed = true;
      }
    }

    if (changed) {
      logger.info('State imported', { toolCount: Object.keys(state).length });
      this.notifyListeners();
    }
  }

  // Private methods

  /** Internal method to register a native tool without logging or notifying listeners */
  private registerNativeToolInternal(options: NativeToolRegistrationOptions): void {
    const { id, description, inputSchema, enabled = true } = options;

    const defaults = getNativeToolDefaults(id);
    const category = options.category ?? defaults?.category ?? 'action';
    const loadingTier = options.loadingTier ?? defaults?.loadingTier ?? 'conditional';
    const estimatedTokens = options.estimatedTokens ?? defaults?.estimatedTokens ?? 100;
    const requiresApproval = options.requiresApproval ?? defaults?.requiresApproval ?? false;

    const existing = this.tools.get(id);
    const metadata: UnifiedToolMetadata = {
      id,
      source: 'native',
      category,
      loadingTier,
      description,
      inputSchema,
      enabled: existing?.enabled ?? enabled,
      discoveredAt: existing?.discoveredAt ?? Date.now(),
      estimatedTokens,
      requiresApproval,
    };

    this.tools.set(id, metadata);

    if (!this.toolsByServer.has('native')) {
      this.toolsByServer.set('native', new Set());
    }
    this.toolsByServer.get('native')?.add(id);
  }

  private extractDescription(tool: unknown): string {
    if (tool && typeof tool === 'object' && 'description' in tool) {
      return String(tool.description);
    }
    return 'No description available';
  }

  private extractInputSchema(tool: unknown): unknown {
    if (tool && typeof tool === 'object' && 'inputSchema' in tool) {
      return tool.inputSchema;
    }
    return undefined;
  }

  private matchPattern(toolId: string, pattern: string): boolean {
    if (pattern === '*') {
      return true;
    }
    if (pattern === toolId) {
      return true;
    }

    // Support glob-style wildcards
    const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(toolId);
  }

  private notifyListeners(): void {
    const tools = this.getAllTools();
    const listenersToRemove: ToolRegistryListener[] = [];

    for (const listener of this.listeners) {
      try {
        listener(tools);
        this.listenerErrors.delete(listener);
      } catch (error) {
        const errorCount = (this.listenerErrors.get(listener) ?? 0) + 1;
        this.listenerErrors.set(listener, errorCount);
        logger.error('Listener error', {
          error: error instanceof Error ? error.message : String(error),
          errorCount,
        });
        if (errorCount >= this.maxListenerErrors) {
          logger.warn('Removing listener after repeated failures', {
            errorCount,
          });
          listenersToRemove.push(listener);
        }
      }
    }

    if (listenersToRemove.length > 0) {
      for (const listener of listenersToRemove) {
        const index = this.listeners.indexOf(listener);
        if (index !== -1) {
          this.listeners.splice(index, 1);
        }
        this.listenerErrors.delete(listener);
      }
    }
  }
}

/**
 * Singleton instance for use across the application.
 */
export const unifiedToolRegistry = new UnifiedToolRegistry();

/**
 * Create a new registry instance (useful for testing or isolated contexts).
 */
export function createUnifiedToolRegistry(): UnifiedToolRegistry {
  return new UnifiedToolRegistry();
}
