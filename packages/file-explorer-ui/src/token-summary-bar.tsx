import { Badge, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@brainstrike/ui';
import { CheckCircle2, Files, Layers, type LucideIcon, TreePine } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import type { TokenCountingState } from './use-token-counting';

type StatItemProps = {
  icon: LucideIcon;
  iconColor?: string;
  label: string;
  value: string | number;
  tooltip?: ReactNode;
  muted?: boolean;
};

const StatItem = memo<StatItemProps>(function StatItem({
  icon: Icon,
  iconColor = 'text-muted-foreground',
  label,
  value,
  tooltip,
  muted = false,
}) {
  const content = (
    <div
      className={`flex items-center gap-1.5 transition-opacity ${muted ? 'opacity-50' : 'opacity-100'}`}
    >
      <Icon className={`size-3.5 flex-shrink-0 ${iconColor}`} />
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-medium text-xs tabular-nums">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </span>
    </div>
  );

  if (!tooltip) {
    return content;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-default">{content}</div>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
});

type TokenStatusBadgeProps = {
  tokenCounting: TokenCountingState;
};

const TokenStatusBadge = memo<TokenStatusBadgeProps>(function TokenStatusBadge({ tokenCounting }) {
  const isAccurate = tokenCounting.mode === 'accurate';
  const isLoading = tokenCounting.loading;

  if (isLoading) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          className="gap-1 px-2 py-0.5 text-[10px]"
          variant={isAccurate ? 'secondary' : 'outline'}
        >
          <CheckCircle2
            className={`size-3 ${isAccurate ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}
          />
          {isAccurate ? 'WASM' : 'Heuristic'}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="text-xs">
          {isAccurate
            ? 'Using tiktoken WASM encoder for accurate token counts'
            : 'Using 4 chars/token heuristic (less accurate)'}
        </div>
      </TooltipContent>
    </Tooltip>
  );
});

type BudgetStatusProps = {
  remaining: number;
  isOverBudget: boolean;
};

const BudgetStatus = memo<BudgetStatusProps>(function BudgetStatus({ remaining, isOverBudget }) {
  return (
    <div
      className={`flex items-center gap-1 rounded-md px-2 py-0.5 font-medium text-xs ${
        isOverBudget
          ? 'bg-destructive/10 text-destructive'
          : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      }`}
    >
      <span className="tabular-nums">{Math.abs(remaining).toLocaleString()}</span>
      <span>{isOverBudget ? 'over' : 'left'}</span>
    </div>
  );
});

type TokenSummaryBarProps = {
  totalFiles: number;
  selectedTokens: number;
  treeTokens: number;
  includeTree: boolean;
  treeLoading?: boolean;
  /** BST-153: Number of files still being indexed (for "estimating..." state) */
  selectedTokensPendingCount?: number;
  budget: number;
  isOverBudget: boolean;
  tokenCounting: TokenCountingState;
};

/**
 * TokenSummaryBar - A compact horizontal bar showing token statistics.
 *
 * Displays file count, token breakdown (selected vs tree), and budget status
 * in a responsive layout that gracefully collapses at smaller widths.
 */
export const TokenSummaryBar = memo<TokenSummaryBarProps>(function TokenSummaryBar({
  totalFiles,
  selectedTokens,
  treeTokens,
  includeTree,
  treeLoading = false,
  selectedTokensPendingCount = 0,
  budget,
  isOverBudget,
  tokenCounting,
}) {
  const remaining = budget - (selectedTokens + (includeTree ? treeTokens : 0));
  // BST-153: Show estimating indicator when files are still being indexed
  const isEstimating = selectedTokensPendingCount > 0;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1.5">
        {/* File count */}
        <StatItem
          icon={Files}
          label=""
          tooltip="Total files in selection"
          value={`${totalFiles} files`}
        />

        {/* Divider */}
        <div aria-hidden className="hidden h-4 w-px bg-border sm:block" />

        {/* Selected tokens - BST-153: Show estimating state */}
        <StatItem
          icon={Layers}
          iconColor="text-primary"
          label=""
          tooltip={
            <div className="text-xs">
              <div className="font-medium">Selected Tokens</div>
              <div className="text-muted-foreground">
                {isEstimating
                  ? `Counting ${selectedTokensPendingCount} of ${totalFiles} file${totalFiles !== 1 ? 's' : ''}…`
                  : `Tokens from ${totalFiles} selected file${totalFiles !== 1 ? 's' : ''}`}
              </div>
            </div>
          }
          value={
            isEstimating
              ? `${selectedTokens.toLocaleString()}+ estimating…`
              : `${selectedTokens.toLocaleString()} selected`
          }
        />

        {/* Tree tokens (if enabled) */}
        <StatItem
          icon={TreePine}
          iconColor="text-[hsl(var(--chart-2))]"
          label=""
          muted={!includeTree}
          tooltip={
            <div className="text-xs">
              <div className="font-medium">Tree Tokens</div>
              <div className="text-muted-foreground">
                {includeTree
                  ? 'Project tree structure included in context'
                  : 'Project tree not included (disabled)'}
              </div>
            </div>
          }
          value={treeLoading ? '…' : `${treeTokens.toLocaleString()} tree`}
        />

        {/* Spacer for right-aligned items */}
        <div className="flex-1" />

        {/* Token counting status badge */}
        <TokenStatusBadge tokenCounting={tokenCounting} />

        {/* Budget remaining/over status */}
        <BudgetStatus isOverBudget={isOverBudget} remaining={remaining} />
      </div>
    </TooltipProvider>
  );
});
