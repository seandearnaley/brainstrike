/**
 * Pure utility for computing token usage metrics from budget and selection state.
 *
 * Extracted from preview-panel.tsx to reduce component module size and
 * make the metric computation independently testable.
 */

import type { TokenUsageMetrics } from '../preview/preview-panel-footer';

interface TokenUsageMetricsInput {
  activeRangeFilesCount: number;
  budget: number;
  includeProjectTree: boolean;
  projectTreeTokenCount: number;
  projectTreeTokenCountLoading: boolean;
  rangeAdjustedFilesCount: number;
  selectedTokens: number;
  sourceSelectedTokens: number;
}

export function getTokenUsageMetrics(args: TokenUsageMetricsInput): TokenUsageMetrics {
  const { budget } = args;
  const includedTreeTokens = args.includeProjectTree ? args.projectTreeTokenCount : 0;
  const usedTokens = args.selectedTokens + includedTreeTokens;
  const remainingTokens = budget - usedTokens;
  const isOverBudget = remainingTokens < 0;

  // For the segmented bar, normalize to the budget when under-budget so the "remaining" track is visible,
  // and normalize to total usage when over-budget so both segments remain visible.
  const barBaseTokens = Math.max(budget, usedTokens, 1);
  const treePercent = (includedTreeTokens / barBaseTokens) * 100;
  const selectedPercent = (args.selectedTokens / barBaseTokens) * 100;
  const usedPercent = budget > 0 ? Math.min((usedTokens / budget) * 100, 100) : 0;

  const treeLabel = args.projectTreeTokenCountLoading
    ? '\u2026'
    : args.projectTreeTokenCount.toLocaleString();
  const remainingLabel = isOverBudget
    ? `${Math.abs(remainingTokens).toLocaleString()} over`
    : `${remainingTokens.toLocaleString()} remaining`;

  return {
    budget,
    sourceSelectedTokens: args.sourceSelectedTokens,
    includedTreeTokens,
    isOverBudget,
    rangeAdjustedFilesCount: args.rangeAdjustedFilesCount,
    activeRangeFilesCount: args.activeRangeFilesCount,
    remainingLabel,
    selectedPercent,
    selectedTokens: args.selectedTokens,
    treeLabel,
    treePercent,
    usedPercent,
    usedTokens,
  };
}
