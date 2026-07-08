/**
 * Three-Tier Tool Loader
 *
 * Implements the three-tier loading strategy for agent tools:
 * - Critical: Always loaded at initialization
 * - Conditional: Loaded based on token budget
 * - Deferred: Loaded only on explicit request
 *
 * Integrates with both native tools and MCP tools through the unified registry.
 */

import { createLogger } from '@brainstrike/utils/logger';
import type { ToolsInput } from '@mastra/core/agent';
import type { TokenBudgetManager, ToolSelectionResult } from './token-budget-manager';
import type { ToolLoadingTier } from './tool-categories';
import type { UnifiedToolMetadata, UnifiedToolRegistry } from './unified-registry';

const logger = createLogger('ToolLoader');

/**
 * Result of loading tools for an agent session.
 */
export interface ToolLoadingResult {
  /** Tools that were not loaded due to budget constraints */
  budgetSkippedTools: UnifiedToolMetadata[];
  /** Breakdown by tier */
  byTier: {
    critical: ToolSelectionResult;
    conditional: ToolSelectionResult;
  };
  /** Deferred tools available for on-demand loading */
  deferredTools: UnifiedToolMetadata[];
  /** Tools that were loaded and are available */
  loadedTools: UnifiedToolMetadata[];
  /** Token budget that was available */
  tokenBudget: number;
  /** Total tokens used by loaded tools */
  tokensUsed: number;
}

/**
 * Options for tool loading.
 */
export interface ToolLoadingOptions {
  /** Token budget manager for budget-aware loading */
  budgetManager?: TokenBudgetManager;
  /** Exclude specific tool IDs */
  excludeToolIds?: string[];
  /** Override which tiers to load (defaults to critical + conditional) */
  loadTiers?: ToolLoadingTier[];
  /** Only load tools from specific source */
  source?: 'native' | 'mcp';
  /** Filter to specific tool IDs */
  toolIds?: string[];
}

/**
 * Options for on-demand tool loading.
 */
export interface OnDemandLoadOptions {
  /** Maximum tokens to allocate for deferred tools */
  maxTokens?: number;
  /** Tool IDs to load */
  toolIds: string[];
}

/**
 * Result of on-demand loading.
 */
export interface OnDemandLoadResult {
  /** Successfully loaded tools */
  loaded: UnifiedToolMetadata[];
  /** Tools that could not be loaded (not found or disabled) */
  notFound: string[];
  /** Tokens used by loaded tools */
  tokensUsed: number;
}

/**
 * Tool Loader
 *
 * Manages loading tools into agent context with three-tier priority.
 */
export class ToolLoader {
  private readonly loadedToolIds: Set<string> = new Set();

  constructor(
    private readonly registry: UnifiedToolRegistry,
    private readonly budgetManager?: TokenBudgetManager
  ) {}

  /**
   * Load tools for an agent session.
   * Respects token budget and tier priorities.
   */
  loadTools(options: ToolLoadingOptions = {}): ToolLoadingResult {
    const loadTiers = options.loadTiers ?? ['critical', 'conditional'];
    const includeDeferred = loadTiers.includes('deferred');

    logger.debug('Loading tools', { loadTiers, source: options.source });

    // Get all enabled tools
    let tools = this.registry.getEnabledTools();

    // Apply source filter
    if (options.source) {
      tools = tools.filter((t) => t.source === options.source);
    }

    // Apply tool ID filters
    if (options.toolIds && options.toolIds.length > 0) {
      const allowedIds = new Set(options.toolIds);
      tools = tools.filter((t) => allowedIds.has(t.id));
    }

    if (options.excludeToolIds && options.excludeToolIds.length > 0) {
      const excludedIds = new Set(options.excludeToolIds);
      tools = tools.filter((t) => !excludedIds.has(t.id));
    }

    // Separate tools by tier
    const criticalTools = tools.filter((t) => t.loadingTier === 'critical');
    const conditionalTools = tools.filter((t) => t.loadingTier === 'conditional');
    const deferredTools = tools.filter((t) => t.loadingTier === 'deferred');

    // If no budget manager, load all requested tiers
    if (!this.budgetManager) {
      const loadedTools: UnifiedToolMetadata[] = [];

      if (loadTiers.includes('critical')) {
        loadedTools.push(...criticalTools);
      }
      if (loadTiers.includes('conditional')) {
        loadedTools.push(...conditionalTools);
      }
      if (includeDeferred) {
        loadedTools.push(...deferredTools);
      }

      const tokensUsed = loadedTools.reduce((sum, t) => sum + t.estimatedTokens, 0);

      // Track loaded tools
      for (const tool of loadedTools) {
        this.loadedToolIds.add(tool.id);
      }

      logger.info('Tools loaded (no budget)', {
        deferred: deferredTools.length,
        loaded: loadedTools.length,
        tokensUsed,
      });

      return {
        budgetSkippedTools: [],
        byTier: {
          conditional: {
            budgetAvailable: Number.POSITIVE_INFINITY,
            selectedTools: conditionalTools,
            skippedTools: [],
            tokensRemaining: Number.POSITIVE_INFINITY,
            tokensUsed: conditionalTools.reduce((sum, t) => sum + t.estimatedTokens, 0),
          },
          critical: {
            budgetAvailable: Number.POSITIVE_INFINITY,
            selectedTools: criticalTools,
            skippedTools: [],
            tokensRemaining: Number.POSITIVE_INFINITY,
            tokensUsed: criticalTools.reduce((sum, t) => sum + t.estimatedTokens, 0),
          },
        },
        deferredTools,
        loadedTools,
        tokenBudget: Number.POSITIVE_INFINITY,
        tokensUsed,
      };
    }

    // Use budget manager for selection
    const criticalResult = this.budgetManager.selectCriticalTools(criticalTools);
    const conditionalResult = this.budgetManager.selectConditionalTools(
      conditionalTools,
      criticalResult.tokensUsed
    );

    const loadedTools: UnifiedToolMetadata[] = [];
    const budgetSkippedTools: UnifiedToolMetadata[] = [];

    if (loadTiers.includes('critical')) {
      loadedTools.push(...criticalResult.selectedTools);
      budgetSkippedTools.push(...criticalResult.skippedTools);
    }

    if (loadTiers.includes('conditional')) {
      loadedTools.push(...conditionalResult.selectedTools);
      budgetSkippedTools.push(...conditionalResult.skippedTools);
    }

    if (includeDeferred) {
      loadedTools.push(...deferredTools);
    }

    const tokensUsed = loadedTools.reduce((sum, t) => sum + t.estimatedTokens, 0);
    const tokenBudget =
      this.budgetManager.getCriticalToolsBudget() + this.budgetManager.getConditionalToolsBudget();

    // Track loaded tools
    for (const tool of loadedTools) {
      this.loadedToolIds.add(tool.id);
    }

    logger.info('Tools loaded', {
      deferred: deferredTools.length,
      loaded: loadedTools.length,
      skipped: budgetSkippedTools.length,
      tokenBudget,
      tokensUsed,
    });

    return {
      budgetSkippedTools,
      byTier: {
        conditional: conditionalResult,
        critical: criticalResult,
      },
      deferredTools,
      loadedTools,
      tokenBudget,
      tokensUsed,
    };
  }

  /**
   * Load deferred tools on demand.
   */
  loadOnDemand(options: OnDemandLoadOptions): OnDemandLoadResult {
    const { toolIds, maxTokens = Number.POSITIVE_INFINITY } = options;

    const loaded: UnifiedToolMetadata[] = [];
    const notFound: string[] = [];
    let tokensUsed = 0;

    for (const id of toolIds) {
      const tool = this.registry.getTool(id);

      if (!tool) {
        notFound.push(id);
        continue;
      }

      if (!tool.enabled) {
        notFound.push(id);
        continue;
      }

      // Check token budget
      if (tokensUsed + tool.estimatedTokens > maxTokens) {
        logger.warn('Skipping tool due to budget', { id, tokens: tool.estimatedTokens });
        continue;
      }

      loaded.push(tool);
      tokensUsed += tool.estimatedTokens;
      this.loadedToolIds.add(id);
    }

    logger.debug('On-demand tools loaded', {
      loaded: loaded.length,
      notFound: notFound.length,
      requested: toolIds.length,
      tokensUsed,
    });

    return { loaded, notFound, tokensUsed };
  }

  /**
   * Get currently loaded tool IDs.
   */
  getLoadedToolIds(): string[] {
    return Array.from(this.loadedToolIds);
  }

  /**
   * Check if a tool is currently loaded.
   */
  isToolLoaded(toolId: string): boolean {
    return this.loadedToolIds.has(toolId);
  }

  /**
   * Unload a specific tool.
   */
  unloadTool(toolId: string): boolean {
    return this.loadedToolIds.delete(toolId);
  }

  /**
   * Clear all loaded tools.
   */
  clearLoaded(): void {
    this.loadedToolIds.clear();
  }

  /**
   * Filter a ToolsInput object to only include loaded tools.
   */
  filterToLoaded(tools: ToolsInput): ToolsInput {
    const filtered: ToolsInput = {};

    for (const [id, tool] of Object.entries(tools)) {
      if (this.loadedToolIds.has(id)) {
        filtered[id] = tool;
      }
    }

    return filtered;
  }

  /**
   * Get tools that require approval before execution.
   */
  getApprovalRequiredTools(): UnifiedToolMetadata[] {
    return Array.from(this.loadedToolIds)
      .map((id) => this.registry.getTool(id))
      .filter(
        (tool): tool is UnifiedToolMetadata => tool !== undefined && tool.requiresApproval === true
      );
  }

  /**
   * Search for tools by query (for conditional loading).
   * Returns matching tools sorted by relevance.
   */
  searchTools(
    query: string,
    options?: { limit?: number; tiers?: ToolLoadingTier[] }
  ): UnifiedToolMetadata[] {
    const limit = options?.limit ?? 5;
    const tiers = options?.tiers ?? ['conditional', 'deferred'];

    const normalizedQuery = query.toLowerCase().trim();
    if (!normalizedQuery) {
      return [];
    }

    const tools = this.registry.getEnabledTools().filter((t) => {
      if (!tiers.includes(t.loadingTier)) {
        return false;
      }

      // Search in ID and description
      const searchText = `${t.id} ${t.description}`.toLowerCase();
      return searchText.includes(normalizedQuery);
    });

    // Sort by relevance (exact ID match first, then description match)
    return tools
      .sort((a, b) => {
        const aIdMatch = a.id.toLowerCase().includes(normalizedQuery) ? 0 : 1;
        const bIdMatch = b.id.toLowerCase().includes(normalizedQuery) ? 0 : 1;
        return aIdMatch - bIdMatch;
      })
      .slice(0, limit);
  }
}

/**
 * Create a tool loader instance.
 */
export function createToolLoader(
  registry: UnifiedToolRegistry,
  budgetManager?: TokenBudgetManager
): ToolLoader {
  return new ToolLoader(registry, budgetManager);
}

/**
 * Convenience function to load tools and return a ToolsInput compatible object.
 * Filters the provided tools to only include those selected by the loader.
 */
export function loadToolsForAgent(
  registry: UnifiedToolRegistry,
  availableTools: ToolsInput,
  options?: ToolLoadingOptions & { budgetManager?: TokenBudgetManager }
): {
  tools: ToolsInput;
  result: ToolLoadingResult;
} {
  const loader = createToolLoader(registry, options?.budgetManager);
  const result = loader.loadTools(options);

  const loadedIds = new Set(result.loadedTools.map((t) => t.id));
  const tools: ToolsInput = {};

  for (const [id, tool] of Object.entries(availableTools)) {
    if (loadedIds.has(id)) {
      tools[id] = tool;
    }
  }

  return { result, tools };
}
