/**
 * Token Budget Summary
 *
 * Displays token budget usage with a segmented progress bar.
 */

import { cn } from '@brainstrike/ui';
import { useState } from 'react';
import type { TokenBudgetSummaryProps } from './types';

/**
 * Token Budget Summary Component
 */
export function TokenBudgetSummary({
  criticalTokens,
  conditionalTokens,
  totalBudget,
  contextWindowSize: _contextWindowSize,
}: TokenBudgetSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  const usedTokens = criticalTokens + conditionalTokens;
  const availableTokens = Math.max(0, totalBudget - usedTokens);
  const usagePercent = totalBudget > 0 ? (usedTokens / totalBudget) * 100 : 0;

  const criticalPercent = totalBudget > 0 ? (criticalTokens / totalBudget) * 100 : 0;
  const conditionalPercent = totalBudget > 0 ? (conditionalTokens / totalBudget) * 100 : 0;

  const isWarning = usagePercent > 90;
  const isError = usagePercent > 100;

  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-colors',
        isError
          ? 'border-destructive/50 bg-destructive/5'
          : isWarning
            ? 'border-yellow-500/50 bg-yellow-500/5'
            : 'border-border bg-muted/30'
      )}
      data-testid="token-budget-summary"
    >
      <button
        className="flex w-full items-center justify-between text-left"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className="font-medium text-sm">Token Budget</span>
        <span className="text-muted-foreground text-sm">
          {usedTokens.toLocaleString()} / {(totalBudget / 1000).toFixed(0)}K
          <span className="ml-2">{usagePercent.toFixed(0)}%</span>
        </span>
      </button>

      {/* Progress Bar */}
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
        <div className="flex h-full">
          <div
            className="bg-primary transition-all"
            data-testid="critical-segment"
            style={{ width: `${Math.min(criticalPercent, 100)}%` }}
          />
          <div
            className="bg-secondary transition-all"
            data-testid="conditional-segment"
            style={{ width: `${Math.min(conditionalPercent, 100 - criticalPercent)}%` }}
          />
        </div>
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="mt-3 flex flex-wrap gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-primary" />
            <span>Critical ({criticalTokens.toLocaleString()})</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-secondary" />
            <span>Conditional ({conditionalTokens.toLocaleString()})</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-muted" />
            <span>Available ({availableTokens.toLocaleString()})</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default TokenBudgetSummary;
