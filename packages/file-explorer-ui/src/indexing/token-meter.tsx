import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@brainstrike/ui';
import { memo, useMemo } from 'react';
import { formatTokenCount } from '../preview/use-preview-panel-state';

interface TokenMeterProps {
  budget: number;
  includeTree: boolean;
  isOverBudget: boolean;
  selectedTokens: number;
  size?: 'sm' | 'md' | 'lg';
  sourceSelectedTokens?: number;
  treeTokens: number;
  usedTokens: number;
  useTapestryRanges?: boolean;
}

const SIZES = {
  sm: { diameter: 48, stroke: 4, fontSize: 'text-[10px]', labelSize: 'text-[8px]' },
  md: { diameter: 64, stroke: 5, fontSize: 'text-xs', labelSize: 'text-[9px]' },
  lg: { diameter: 80, stroke: 6, fontSize: 'text-sm', labelSize: 'text-[10px]' },
} as const;

/** Usage thresholds for color transitions (percentage of budget) */
const USAGE_THRESHOLDS = {
  /** Above this percentage: show warning (amber) */
  warning: 90,
  /** Above this percentage: show caution (yellow) */
  caution: 75,
} as const;

/**
 * TokenMeter - A circular progress indicator for token budget visualization.
 *
 * Features:
 * - Radial arc showing budget utilization
 * - Segmented display for selected vs tree tokens
 * - Color transitions based on usage level
 * - Smooth CSS animations
 * - Tooltip with detailed breakdown
 */
export const TokenMeter = memo<TokenMeterProps>(function TokenMeter({
  usedTokens,
  budget,
  selectedTokens,
  sourceSelectedTokens = selectedTokens,
  treeTokens,
  includeTree,
  useTapestryRanges = false,
  isOverBudget,
  size = 'md',
}) {
  const config = SIZES[size];
  const radius = (config.diameter - config.stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = config.diameter / 2;

  const { selectedOffset, treeOffset, bgClass, ringClass } = useMemo(() => {
    // Calculate percentages capped at 100%
    const totalPercent = Math.min((usedTokens / Math.max(budget, 1)) * 100, 100);
    const selectedPercent =
      budget > 0 ? Math.min((selectedTokens / budget) * 100, totalPercent) : 0;
    const treePercent = includeTree
      ? Math.min((treeTokens / budget) * 100, totalPercent - selectedPercent)
      : 0;

    // Calculate stroke-dashoffset for each segment
    // The arc is drawn clockwise from the top
    const selectedLength = (selectedPercent / 100) * circumference;
    const treeLength = (treePercent / 100) * circumference;

    // Color logic based on usage
    let bg: string;
    let ring: string;

    if (isOverBudget) {
      bg = 'from-destructive/20 to-destructive/5';
      ring = 'ring-destructive/30';
    } else if (totalPercent > USAGE_THRESHOLDS.warning) {
      bg = 'from-amber-500/20 to-amber-500/5';
      ring = 'ring-amber-500/30';
    } else if (totalPercent > USAGE_THRESHOLDS.caution) {
      bg = 'from-yellow-500/15 to-yellow-500/5';
      ring = 'ring-yellow-500/20';
    } else {
      bg = 'from-primary/10 to-primary/5';
      ring = 'ring-primary/20';
    }

    return {
      selectedOffset: circumference - selectedLength,
      treeOffset: circumference - treeLength,
      selectedLength,
      treeLength,
      bgClass: bg,
      ringClass: ring,
    };
  }, [usedTokens, budget, selectedTokens, treeTokens, includeTree, isOverBudget, circumference]);

  const tooltipContent = useMemo(() => {
    const remaining = budget - usedTokens;
    return (
      <div className="space-y-1.5 text-xs">
        <div className="font-medium">Token Usage</div>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <span className="text-muted-foreground">
            {useTapestryRanges ? 'Output:' : 'Selected:'}
          </span>
          <span className="font-medium tabular-nums">{selectedTokens.toLocaleString()}</span>
          {useTapestryRanges && (
            <>
              <span className="text-muted-foreground">Source:</span>
              <span className="font-medium tabular-nums">
                {sourceSelectedTokens.toLocaleString()}
              </span>
            </>
          )}
          {includeTree && (
            <>
              <span className="text-muted-foreground">Tree:</span>
              <span className="font-medium tabular-nums">{treeTokens.toLocaleString()}</span>
            </>
          )}
          <span className="text-muted-foreground">Budget:</span>
          <span className="font-medium tabular-nums">{budget.toLocaleString()}</span>
          <span className="border-border border-t pt-0.5 text-muted-foreground">
            {isOverBudget ? 'Over:' : 'Remaining:'}
          </span>
          <span
            className={`border-border border-t pt-0.5 font-medium tabular-nums ${isOverBudget ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}`}
          >
            {Math.abs(remaining).toLocaleString()}
          </span>
        </div>
      </div>
    );
  }, [
    usedTokens,
    budget,
    selectedTokens,
    sourceSelectedTokens,
    treeTokens,
    includeTree,
    useTapestryRanges,
    isOverBudget,
  ]);

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* biome-ignore lint/a11y/useSemanticElements: Custom SVG-based meter visualization requires div wrapper */}
          <div
            aria-label={`Token usage: ${usedTokens.toLocaleString()} of ${budget.toLocaleString()}`}
            aria-valuemax={budget}
            aria-valuemin={0}
            aria-valuenow={usedTokens}
            className={`relative flex-shrink-0 cursor-default rounded-full bg-gradient-to-br p-0.5 ring-1 ring-inset transition-all duration-300 ${bgClass} ${ringClass}`}
            role="meter"
            style={{ width: config.diameter + 4, height: config.diameter + 4 }}
          >
            <svg
              aria-hidden="true"
              className="rotate-[-90deg] transform"
              height={config.diameter}
              viewBox={`0 0 ${config.diameter} ${config.diameter}`}
              width={config.diameter}
            >
              {/* Background track */}
              <circle
                className="text-secondary"
                cx={center}
                cy={center}
                fill="none"
                r={radius}
                stroke="currentColor"
                strokeWidth={config.stroke}
              />
              {/* Tree tokens segment (if included) */}
              {includeTree && treeTokens > 0 && (
                <circle
                  className="text-[hsl(var(--chart-2))] transition-[stroke-dashoffset] duration-500 ease-out"
                  cx={center}
                  cy={center}
                  fill="none"
                  r={radius}
                  stroke="currentColor"
                  strokeDasharray={circumference}
                  strokeDashoffset={treeOffset}
                  strokeLinecap="round"
                  strokeWidth={config.stroke}
                  style={{
                    transform: `rotate(${(selectedTokens / Math.max(budget, 1)) * 360}deg)`,
                    transformOrigin: 'center',
                  }}
                />
              )}
              {/* Selected tokens segment */}
              <circle
                className={`transition-[stroke-dashoffset] duration-500 ease-out ${isOverBudget ? 'text-destructive' : 'text-primary'}`}
                cx={center}
                cy={center}
                fill="none"
                r={radius}
                stroke="currentColor"
                strokeDasharray={circumference}
                strokeDashoffset={selectedOffset}
                strokeLinecap="round"
                strokeWidth={config.stroke}
              />
            </svg>
            {/* Center text */}
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span
                className={`font-semibold tabular-nums leading-none ${config.fontSize} ${isOverBudget ? 'text-destructive' : ''}`}
              >
                {formatTokenCount(usedTokens)}
              </span>
              <span className={`text-muted-foreground ${config.labelSize}`}>tokens</span>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltipContent}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});
