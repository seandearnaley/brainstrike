import { createLogger } from '@brainstrike/logging';
import type { ToolsInput } from '@mastra/core/agent';

const logger = createLogger('ToolRegistry');

/**
 * What `register` reads from a discovered tool: its model-facing metadata,
 * nothing executable. Executable Mastra/AI SDK tools satisfy it structurally,
 * and so do the desktop's persisted discovery records, which carry no
 * executor at all. (Typing this as Mastra's `ToolsInput` was only ever true
 * by accident: through 1.59 the provider-defined member had an open index
 * signature; 1.64 requires an `id` there.)
 */
export interface McpRegistrableTool {
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
}

/** Discovery metadata records or live Mastra/AI SDK tool definitions. */
export type McpRegistrableTools = Readonly<Record<string, McpRegistrableTool | ToolsInput[string]>>;

export interface McpToolMetadata {
  description?: string;
  discoveredAt: number;
  enabled: boolean;
  id: string;
  inputSchema?: unknown;
  serverName: string;
}

export interface McpToolsByServer {
  [serverName: string]: McpToolMetadata[];
}

export interface ToolFilterConfig {
  enabledTools?: string[];
}

// Shared across ToolRegistry instances on purpose so repeated pattern matching reuses the
// same compiled regexes, even though the app currently relies on the singleton export.
const TOOL_PATTERN_CACHE = new Map<string, RegExp>();
const TOOL_PATTERN_CACHE_LIMIT = 256;

function matchToolPattern(toolId: string, pattern: string): boolean {
  if (pattern === '*' || pattern === toolId) {
    return true;
  }

  let regex = TOOL_PATTERN_CACHE.get(pattern);
  if (!regex) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexPattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    regex = new RegExp(`^${regexPattern}$`);
    if (TOOL_PATTERN_CACHE.size >= TOOL_PATTERN_CACHE_LIMIT) {
      const oldestPattern = TOOL_PATTERN_CACHE.keys().next().value;
      if (oldestPattern !== undefined) {
        TOOL_PATTERN_CACHE.delete(oldestPattern);
      }
    }
    TOOL_PATTERN_CACHE.set(pattern, regex);
  }

  return regex.test(toolId);
}

export function isToolEnabledByFilterConfig(
  toolId: string,
  filterConfig?: ToolFilterConfig
): boolean {
  if (!filterConfig?.enabledTools) {
    return true;
  }

  const { enabledTools } = filterConfig;

  if (
    enabledTools.some(
      (pattern) => pattern.startsWith('!') && matchToolPattern(toolId, pattern.slice(1))
    )
  ) {
    return false;
  }

  if (enabledTools.includes('*')) {
    return true;
  }

  return enabledTools.some((pattern) => matchToolPattern(toolId, pattern));
}

export function isAnyToolIdEnabledByFilterConfig(
  toolIds: readonly string[],
  filterConfig?: ToolFilterConfig
): boolean {
  if (!filterConfig?.enabledTools) {
    return true;
  }

  const { enabledTools } = filterConfig;

  if (
    enabledTools.some(
      (pattern) =>
        pattern.startsWith('!') &&
        toolIds.some((toolId) => matchToolPattern(toolId, pattern.slice(1)))
    )
  ) {
    return false;
  }

  if (enabledTools.includes('*')) {
    return true;
  }

  return enabledTools.some((pattern) =>
    toolIds.some((toolId) => matchToolPattern(toolId, pattern))
  );
}

/**
 * Registry for tracking MCP tools discovered from servers.
 * Manages tool metadata, enabled/disabled state, and filtering.
 */
export class ToolRegistry {
  private readonly tools: Map<string, McpToolMetadata> = new Map();
  private readonly toolsByServer: Map<string, Set<string>> = new Map();
  private readonly listeners: Array<(tools: McpToolsByServer) => void> = [];

  /**
   * Register tools from an MCP server
   */
  register(serverName: string, tools: McpRegistrableTools, filterConfig?: ToolFilterConfig): void {
    const toolIds = new Set<string>();
    const discoveredAt = Date.now();

    for (const [toolId, tool] of Object.entries(tools)) {
      const existing = this.tools.get(toolId);

      // Preserve enabled state if tool was previously registered
      const enabled = existing
        ? existing.enabled
        : this.isToolEnabledByDefault(toolId, filterConfig);

      const description = this.extractDescription(tool);
      const inputSchema = this.extractInputSchema(tool);

      const metadata: McpToolMetadata = {
        id: toolId,
        serverName,
        ...(description !== undefined && { description }),
        ...(inputSchema !== undefined && { inputSchema }),
        discoveredAt,
        enabled,
      };

      this.tools.set(toolId, metadata);
      toolIds.add(toolId);
    }

    this.toolsByServer.set(serverName, toolIds);
    logger.info('tools registered', {
      code: 'tools_registered',
      count: toolIds.size,
      enabled: Array.from(toolIds).filter((id) => this.tools.get(id)?.enabled).length,
      serverName,
    });

    this.notifyListeners();
  }

  /**
   * Get all registered tools grouped by server
   */
  getAllTools(): McpToolsByServer {
    const result: McpToolsByServer = {};

    for (const [serverName, toolIds] of this.toolsByServer.entries()) {
      result[serverName] = Array.from(toolIds)
        .map((id) => this.tools.get(id))
        .filter((tool): tool is McpToolMetadata => tool !== undefined);
    }

    return result;
  }

  /**
   * Get tools from a specific server
   */
  getToolsForServer(serverName: string): McpToolMetadata[] {
    const toolIds = this.toolsByServer.get(serverName);
    if (!toolIds) {
      return [];
    }

    return Array.from(toolIds)
      .map((id) => this.tools.get(id))
      .filter((tool): tool is McpToolMetadata => tool !== undefined);
  }

  getTool(toolId: string): McpToolMetadata | undefined {
    return this.tools.get(toolId);
  }

  /**
   * Enable specific tool(s)
   */
  enableTools(toolIds: string[]): void {
    for (const id of toolIds) {
      const tool = this.tools.get(id);
      if (tool) {
        tool.enabled = true;
        this.tools.set(id, tool);
      }
    }
    logger.info('tools enabled', { code: 'tools_enabled', count: toolIds.length, toolIds });
    this.notifyListeners();
  }

  /**
   * Disable specific tool(s)
   */
  disableTools(toolIds: string[]): void {
    for (const id of toolIds) {
      const tool = this.tools.get(id);
      if (tool) {
        tool.enabled = false;
        this.tools.set(id, tool);
      }
    }
    logger.info('tools disabled', { code: 'tools_disabled', count: toolIds.length, toolIds });
    this.notifyListeners();
  }

  /**
   * Enable all tools from a server
   */
  enableServerTools(serverName: string): void {
    const toolIds = this.toolsByServer.get(serverName);
    if (toolIds) {
      this.enableTools(Array.from(toolIds));
    }
  }

  /**
   * Disable all tools from a server
   */
  disableServerTools(serverName: string): void {
    const toolIds = this.toolsByServer.get(serverName);
    if (toolIds) {
      this.disableTools(Array.from(toolIds));
    }
  }

  /**
   * Get filtered tools suitable for agent runtime (only enabled tools)
   */
  getEnabledTools(originalTools: ToolsInput): ToolsInput {
    const filtered: ToolsInput = {};

    for (const [id, tool] of Object.entries(originalTools)) {
      const metadata = this.tools.get(id);
      if (!metadata || metadata.enabled) {
        filtered[id] = tool;
      }
    }

    return filtered;
  }

  /**
   * Reset all tools to their default enabled state
   */
  reset(filterConfig?: ToolFilterConfig): void {
    for (const [id, tool] of this.tools.entries()) {
      tool.enabled = this.isToolEnabledByDefault(id, filterConfig);
      this.tools.set(id, tool);
    }
    logger.info('tools reset to defaults', { code: 'tools_reset' });
    this.notifyListeners();
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this.tools.clear();
    this.toolsByServer.clear();
    TOOL_PATTERN_CACHE.clear();
    logger.info('registry cleared', { code: 'registry_cleared' });
    this.notifyListeners();
  }

  /**
   * Subscribe to tool state changes
   */
  subscribe(listener: (tools: McpToolsByServer) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Get tool count statistics
   */
  getStats(): { total: number; enabled: number; disabled: number; servers: number } {
    const tools = Array.from(this.tools.values());
    return {
      disabled: tools.filter((t) => !t.enabled).length,
      enabled: tools.filter((t) => t.enabled).length,
      servers: this.toolsByServer.size,
      total: tools.length,
    };
  }

  private extractDescription(tool: McpRegistrableTools[string]): string | undefined {
    if ('description' in tool && tool.description !== undefined) {
      return String(tool.description);
    }
    return;
  }

  private extractInputSchema(tool: McpRegistrableTools[string]): unknown {
    return 'inputSchema' in tool ? tool.inputSchema : undefined;
  }

  private isToolEnabledByDefault(toolId: string, filterConfig?: ToolFilterConfig): boolean {
    return isToolEnabledByFilterConfig(toolId, filterConfig);
  }

  private notifyListeners(): void {
    const tools = this.getAllTools();
    for (const listener of this.listeners) {
      try {
        listener(tools);
      } catch (error) {
        logger.error('listener error', {
          code: 'listener_error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

// Singleton instance for use across the application
export const toolRegistry = new ToolRegistry();
