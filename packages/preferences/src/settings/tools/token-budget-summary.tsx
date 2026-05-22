/**
 * Token Budget Summary
 *
 * Displays token budget usage with a segmented progress bar in a compact single-line layout.
 */

import { cn } from '@brainstrike/ui';
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
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
  const legendId = useId();

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
        'rounded-lg border p-2 transition-colors',
        isError
          ? 'border-destructive/50 bg-destructive/5'
          : isWarning
            ? 'border-yellow-500/50 bg-yellow-500/5'
            : 'border-border bg-muted/30'
      )}
      data-testid="token-budget-summary"
    >
      <button
        aria-controls={expanded ? legendId : undefined}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className="shrink-0 font-medium text-sm">Token Budget</span>

        {/* Inline Progress Bar */}
        <div
          className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
          data-testid="progress-bar-inline"
        >
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

        <span className="shrink-0 text-muted-foreground text-sm">
          {usedTokens.toLocaleString()} / {(totalBudget / 1000).toFixed(0)}K
          <span className="ml-1.5">({usagePercent.toFixed(0)}%)</span>
        </span>

        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180'
          )}
        />
      </button>

      {/* Expanded Legend */}
      {expanded && (
        <div
          className="mt-2 flex flex-wrap gap-4 border-border/50 border-t pt-2 text-xs"
          id={legendId}
        >
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
