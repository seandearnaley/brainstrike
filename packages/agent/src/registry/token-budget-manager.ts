/**
 * Token Budget Manager
 *
 * Manages token budget allocation for tool loading in agent contexts.
 * Implements a three-tier loading strategy with priority-based selection.
 *
 * Budget allocation (percentage of total context):
 * - System Prompt Reserve: 15%
 * - Response Buffer: 10%
 * - Critical Tools (always): 15%
 * - Conditional Tools (budget-aware): 35%
 * - Context/Results: 25%
 */

import { countTokensHeuristic } from '@brainstrike/text-splitter';
import { compareByLoadPriority, TOOL_CATEGORIES, type ToolCategory } from './tool-categories';
import type { UnifiedToolMetadata } from './unified-registry';

/**
 * Budget allocation percentages.
 */
export interface BudgetAllocation {
  /** Available for conditional tools (35%) */
  conditionalTools: number;
  /** Available for context and results (25%) */
  contextResults: number;
  /** Reserved for critical tools - always loaded (15%) */
  criticalTools: number;
  /** Reserved for model response (10%) */
  responseBuffer: number;
  /** Reserved for system prompt (15%) */
  systemPrompt: number;
}

/**
 * Default budget allocation percentages.
 */
export const DEFAULT_BUDGET_ALLOCATION: BudgetAllocation = {
  conditionalTools: 0.35,
  contextResults: 0.25,
  criticalTools: 0.15,
  responseBuffer: 0.1,
  systemPrompt: 0.15,
};

/**
 * Options for creating a token budget manager.
 */
export interface TokenBudgetManagerOptions {
  /** Custom budget allocation (defaults to DEFAULT_BUDGET_ALLOCATION) */
  allocation?: Partial<BudgetAllocation>;
  /** Total context window size in tokens */
  contextWindowTokens: number;
  /** Custom token estimation function */
  estimateTokens?: (text: string) => number;
}

/**
 * Result of tool selection within budget.
 */
export interface ToolSelectionResult {
  /** Budget that was available for selection */
  budgetAvailable: number;
  /** Tools selected for loading */
  selectedTools: UnifiedToolMetadata[];
  /** Tools that were skipped due to budget constraints */
  skippedTools: UnifiedToolMetadata[];
  /** Remaining token budget */
  tokensRemaining: number;
  /** Total tokens used by selected tools */
  tokensUsed: number;
}

/**
 * Budget utilization report.
 */
export interface BudgetUtilizationReport {
  /** Tokens allocated to each category */
  allocatedTokens: {
    systemPrompt: number;
    responseBuffer: number;
    criticalTools: number;
    conditionalTools: number;
    contextResults: number;
  };
  /** Total context window size */
  contextWindowTokens: number;
  /** Remaining tokens after tool loading */
  remainingForContext: number;
  /** Actual token usage */
  usedTokens: {
    criticalTools: number;
    conditionalTools: number;
  };
  /** Utilization percentage */
  utilizationPercent: number;
}

/**
 * Priority configuration for tool selection.
 */
export interface ToolSelectionPriority {
  /** Category priority order (first = highest priority) */
  categoryOrder: ToolCategory[];
  /** Whether to prefer tools with lower estimated tokens */
  preferSmaller: boolean;
}

/**
 * Default priority configuration.
 * Retrieval tools are prioritized for search-heavy workflows.
 */
export const DEFAULT_SELECTION_PRIORITY: ToolSelectionPriority = {
  categoryOrder: ['retrieval', 'analysis', 'action', 'configuration', 'validation'],
  preferSmaller: false,
};

/**
 * Token Budget Manager
 *
 * Manages token allocation for tool loading with three-tier priority system.
 */
export class TokenBudgetManager {
  private readonly contextWindowTokens: number;
  private readonly allocation: BudgetAllocation;
  private readonly estimateTokens: (text: string) => number;

  constructor(options: TokenBudgetManagerOptions) {
    this.contextWindowTokens = options.contextWindowTokens;
    this.allocation = { ...DEFAULT_BUDGET_ALLOCATION, ...options.allocation };
    this.estimateTokens = options.estimateTokens ?? countTokensHeuristic;

    for (const [key, value] of Object.entries(this.allocation)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Budget "${key}" must be positive, got ${value}`);
      }
    }

    // Validate allocation sums to ~1.0
    const sum = Object.values(this.allocation).reduce((a, b) => a + b, 0);
    if (sum < 0.99 || sum > 1.01) {
      throw new Error(`Budget allocation must sum to 1.0, got ${sum.toFixed(2)}`);
    }
  }

  /**
   * Get the token budget for critical tools.
   */
  getCriticalToolsBudget(): number {
    return Math.floor(this.contextWindowTokens * this.allocation.criticalTools);
  }

  /**
   * Get the token budget for conditional tools.
   */
  getConditionalToolsBudget(): number {
    return Math.floor(this.contextWindowTokens * this.allocation.conditionalTools);
  }

  /**
   * Get the token budget for context and results.
   */
  getContextResultsBudget(): number {
    return Math.floor(this.contextWindowTokens * this.allocation.contextResults);
  }

  /**
   * Select tools from a list that fit within a token budget.
   *
   * @param tools - Candidate tools to select from
   * @param budget - Token budget for selection
   * @param priority - Priority configuration for selection order
   */
  selectToolsWithinBudget(
    tools: UnifiedToolMetadata[],
    budget: number,
    priority: ToolSelectionPriority = DEFAULT_SELECTION_PRIORITY
  ): ToolSelectionResult {
    // Sort tools by priority
    const sortedTools = this.sortToolsByPriority(tools, priority);

    const selectedTools: UnifiedToolMetadata[] = [];
    const skippedTools: UnifiedToolMetadata[] = [];
    let tokensUsed = 0;

    for (const tool of sortedTools) {
      if (!tool.enabled) {
        continue;
      }

      const toolTokens = tool.estimatedTokens;

      if (tokensUsed + toolTokens <= budget) {
        selectedTools.push(tool);
        tokensUsed += toolTokens;
      } else {
        skippedTools.push(tool);
      }
    }

    return {
      budgetAvailable: budget,
      selectedTools,
      skippedTools,
      tokensRemaining: budget - tokensUsed,
      tokensUsed,
    };
  }

  /**
   * Select critical tools (always loaded if budget allows).
   */
  selectCriticalTools(tools: UnifiedToolMetadata[]): ToolSelectionResult {
    const criticalTools = tools.filter((t) => t.loadingTier === 'critical' && t.enabled);
    const budget = this.getCriticalToolsBudget();
    return this.selectToolsWithinBudget(criticalTools, budget);
  }

  /**
   * Select conditional tools with remaining budget after critical tools.
   *
   * @param tools - All available tools
   * @param criticalTokensUsed - Tokens already used by critical tools
   */
  selectConditionalTools(
    tools: UnifiedToolMetadata[],
    criticalTokensUsed: number
  ): ToolSelectionResult {
    const conditionalTools = tools.filter((t) => t.loadingTier === 'conditional' && t.enabled);

    // If critical tools exceeded their budget, reduce conditional budget
    const criticalBudget = this.getCriticalToolsBudget();
    const overflow = Math.max(0, criticalTokensUsed - criticalBudget);
    const adjustedBudget = Math.max(0, this.getConditionalToolsBudget() - overflow);

    return this.selectToolsWithinBudget(conditionalTools, adjustedBudget);
  }

  /**
   * Perform full tool selection with three-tier priority.
   *
   * @param tools - All registered tools
   * @param priority - Optional priority configuration
   */
  selectAllTools(
    tools: UnifiedToolMetadata[],
    _priority: ToolSelectionPriority = DEFAULT_SELECTION_PRIORITY
  ): {
    critical: ToolSelectionResult;
    conditional: ToolSelectionResult;
    deferred: UnifiedToolMetadata[];
    totalTokensUsed: number;
  } {
    // 1. Select critical tools (always loaded)
    const critical = this.selectCriticalTools(tools);

    // 2. Select conditional tools with remaining budget
    const conditional = this.selectConditionalTools(tools, critical.tokensUsed);

    // 3. Deferred tools are not loaded but tracked
    const deferred = tools.filter((t) => t.loadingTier === 'deferred' && t.enabled);

    return {
      conditional,
      critical,
      deferred,
      totalTokensUsed: critical.tokensUsed + conditional.tokensUsed,
    };
  }

  /**
   * Generate a budget utilization report.
   */
  getUtilizationReport(
    criticalTokensUsed: number,
    conditionalTokensUsed: number
  ): BudgetUtilizationReport {
    const allocatedTokens = {
      conditionalTools: Math.floor(this.contextWindowTokens * this.allocation.conditionalTools),
      contextResults: Math.floor(this.contextWindowTokens * this.allocation.contextResults),
      criticalTools: Math.floor(this.contextWindowTokens * this.allocation.criticalTools),
      responseBuffer: Math.floor(this.contextWindowTokens * this.allocation.responseBuffer),
      systemPrompt: Math.floor(this.contextWindowTokens * this.allocation.systemPrompt),
    };

    const totalToolTokens = criticalTokensUsed + conditionalTokensUsed;
    const toolBudget = allocatedTokens.criticalTools + allocatedTokens.conditionalTools;
    const remainingForContext = allocatedTokens.contextResults + (toolBudget - totalToolTokens);

    return {
      allocatedTokens,
      contextWindowTokens: this.contextWindowTokens,
      remainingForContext,
      usedTokens: {
        conditionalTools: conditionalTokensUsed,
        criticalTools: criticalTokensUsed,
      },
      utilizationPercent: toolBudget > 0 ? (totalToolTokens / toolBudget) * 100 : 0,
    };
  }

  /**
   * Estimate tokens for a tool schema description.
   */
  estimateToolTokens(tool: { description: string; inputSchema?: unknown }): number {
    let content = tool.description;

    if (tool.inputSchema) {
      content += ` ${JSON.stringify(tool.inputSchema)}`;
    }

    return this.estimateTokens(content);
  }

  /**
   * Check if adding a tool would exceed a budget.
   */
  wouldExceedBudget(currentTokens: number, toolTokens: number, budget: number): boolean {
    return currentTokens + toolTokens > budget;
  }

  // Private methods

  private sortToolsByPriority(
    tools: UnifiedToolMetadata[],
    priority: ToolSelectionPriority
  ): UnifiedToolMetadata[] {
    const categoryPriorityMap = new Map<ToolCategory, number>();
    for (const [index, category] of priority.categoryOrder.entries()) {
      categoryPriorityMap.set(category, index);
    }

    return [...tools].sort((a, b) => {
      // First sort by category priority
      const aPriority =
        categoryPriorityMap.get(a.category) ?? TOOL_CATEGORIES[a.category].loadPriority;
      const bPriority =
        categoryPriorityMap.get(b.category) ?? TOOL_CATEGORIES[b.category].loadPriority;

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      // Then by internal category load priority
      const categoryCompare = compareByLoadPriority(a, b);
      if (categoryCompare !== 0) {
        return categoryCompare;
      }

      // Optionally prefer smaller tools
      if (priority.preferSmaller) {
        return a.estimatedTokens - b.estimatedTokens;
      }

      return 0;
    });
  }
}

/**
 * Create a token budget manager with common context window sizes.
 */
export function createTokenBudgetManager(
  contextWindowTokens: number,
  options?: Partial<TokenBudgetManagerOptions>
): TokenBudgetManager {
  return new TokenBudgetManager({
    contextWindowTokens,
    ...options,
  });
}

/**
 * Create a budget manager for common model context windows.
 */
export const COMMON_CONTEXT_WINDOWS = {
  /** GPT-4 Turbo / Claude 3 (128K) */
  large: 128_000,
  /** GPT-4 / Claude 2 (32K) */
  medium: 32_000,
  /** Smaller models (8K) */
  minimal: 8000,
  /** GPT-3.5 Turbo (16K) */
  small: 16_000,
} as const;

/**
 * Create a budget manager for a specific model tier.
 */
export function createBudgetManagerForTier(
  tier: keyof typeof COMMON_CONTEXT_WINDOWS
): TokenBudgetManager {
  return createTokenBudgetManager(COMMON_CONTEXT_WINDOWS[tier]);
}
