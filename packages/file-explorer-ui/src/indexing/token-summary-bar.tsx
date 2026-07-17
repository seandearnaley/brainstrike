import { Badge, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@brainstrike/ui';
import { CheckCircle2, Files, FileText, Layers, type LucideIcon, TreePine } from 'lucide-react';
import { memo } from 'react';
import type { TokenCountingState } from './use-token-counting';

interface StatItemProps {
  icon: LucideIcon;
  iconColor?: string;
  label: string;
  muted?: boolean;
  value: string | number;
}

const StatItem = memo<StatItemProps>(function StatItem({
  icon: Icon,
  iconColor = 'text-muted-foreground',
  label,
  value,
  muted = false,
}) {
  return (
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
});

interface TokenStatusBadgeProps {
  tokenCounting: TokenCountingState;
}

const TokenStatusBadge = memo<TokenStatusBadgeProps>(function TokenStatusBadge({ tokenCounting }) {
  const isAccurate = tokenCounting.mode === 'accurate' && tokenCounting.reason === null;
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
          {isAccurate
            ? 'WASM'
            : tokenCounting.reason === 'preference-disabled'
              ? 'Heuristic'
              : 'Unavailable'}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="text-xs">
          {isAccurate
            ? 'Using tiktoken WASM encoder for accurate token counts'
            : tokenCounting.reason === 'preference-disabled'
              ? 'Using 4 chars/token heuristic because heuristic mode was explicitly selected'
              : 'Accurate token counting is required, but the tiktoken WASM runtime is currently unavailable'}
        </div>
      </TooltipContent>
    </Tooltip>
  );
});

interface BudgetStatusProps {
  isOverBudget: boolean;
  remaining: number;
}

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

// Stable module-level tooltip for source tokens (no dynamic content)
const SOURCE_TOKENS_TOOLTIP = (
  <div className="text-xs">
    <div className="font-medium">Full-File Source Tokens</div>
    <div className="text-muted-foreground">
      Tokens across complete selected files before tapestry range filtering
    </div>
  </div>
);

interface SelectedTokensTooltipProps {
  activeRangeFilesCount: number;
  isEstimating: boolean;
  rangeAdjustedFilesCount: number;
  selectedTokensPendingCount: number;
  totalFiles: number;
}

const SelectedTokensTooltip = memo<SelectedTokensTooltipProps>(function SelectedTokensTooltip({
  isEstimating,
  totalFiles,
  selectedTokensPendingCount,
  rangeAdjustedFilesCount,
  activeRangeFilesCount,
}) {
  const countedText = isEstimating
    ? `Counted ${totalFiles - selectedTokensPendingCount} of ${totalFiles} file${totalFiles === 1 ? '' : 's'}…`
    : 'Estimated tokens included in final context export';

  return (
    <div className="text-xs">
      <div className="font-medium">Context Output Tokens</div>
      <div className="text-muted-foreground">{countedText}</div>
      <div className="text-muted-foreground">
        {rangeAdjustedFilesCount > 0
          ? `${activeRangeFilesCount} of ${rangeAdjustedFilesCount} ranged file${rangeAdjustedFilesCount === 1 ? '' : 's'} currently include active selections`
          : 'Files without explicit ranges are treated as fully selected'}
      </div>
    </div>
  );
});

interface TreeTokensTooltipProps {
  includeTree: boolean;
}

const TreeTokensTooltip = memo<TreeTokensTooltipProps>(function TreeTokensTooltip({ includeTree }) {
  return (
    <div className="text-xs">
      <div className="font-medium">Tree Tokens</div>
      <div className="text-muted-foreground">
        {includeTree
          ? 'Project tree structure included in context'
          : 'Project tree not included (disabled)'}
      </div>
    </div>
  );
});

interface TokenSummaryBarProps {
  activeRangeFilesCount?: number;
  budget: number;
  includeTree: boolean;
  isOverBudget: boolean;
  rangeAdjustedFilesCount?: number;
  selectedTokens: number;
  /** BST-153: Number of files still being indexed (for "estimating..." state) */
  selectedTokensPendingCount?: number;
  sourceSelectedTokens?: number;
  tokenCounting: TokenCountingState;
  totalFiles: number;
  treeLoading?: boolean;
  treeTokens: number;
}

/**
 * TokenSummaryBar - A compact horizontal bar showing token statistics.
 *
 * Displays file count, token breakdown (selected vs tree), and budget status
 * in a responsive layout that gracefully collapses at smaller widths.
 */
export const TokenSummaryBar = memo<TokenSummaryBarProps>(function TokenSummaryBar({
  totalFiles,
  selectedTokens,
  sourceSelectedTokens = selectedTokens,
  treeTokens,
  includeTree,
  rangeAdjustedFilesCount = 0,
  activeRangeFilesCount = 0,
  treeLoading = false,
  selectedTokensPendingCount = 0,
  budget,
  isOverBudget,
  tokenCounting,
}) {
  const remaining = budget - (selectedTokens + (includeTree ? treeTokens : 0));
  // BST-153: Show estimating indicator when files are still being indexed
  const isEstimating = selectedTokensPendingCount > 0;
  const sourceAndOutputDiffer = sourceSelectedTokens !== selectedTokens;

  const selectedTokensValue = isEstimating
    ? `${selectedTokens.toLocaleString()}+ estimating…`
    : `${selectedTokens.toLocaleString()} output`;

  const treeTokensValue = treeLoading ? '…' : `${treeTokens.toLocaleString()} tree`;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1.5">
        {/* File count */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="cursor-default">
              <StatItem icon={Files} label="" value={`${totalFiles} files`} />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">Total files in selection</TooltipContent>
        </Tooltip>

        {/* Divider */}
        <div aria-hidden className="hidden h-4 w-px bg-border sm:block" />

        {/* Selected tokens - BST-153: Show estimating state */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="cursor-default">
              <StatItem
                icon={Layers}
                iconColor="text-primary"
                label=""
                value={selectedTokensValue}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <SelectedTokensTooltip
              activeRangeFilesCount={activeRangeFilesCount}
              isEstimating={isEstimating}
              rangeAdjustedFilesCount={rangeAdjustedFilesCount}
              selectedTokensPendingCount={selectedTokensPendingCount}
              totalFiles={totalFiles}
            />
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <div className="cursor-default">
              <StatItem
                icon={FileText}
                iconColor="text-muted-foreground"
                label=""
                muted={!sourceAndOutputDiffer}
                value={`${sourceSelectedTokens.toLocaleString()} source`}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">{SOURCE_TOKENS_TOOLTIP}</TooltipContent>
        </Tooltip>

        {/* Tree tokens (if enabled) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="cursor-default">
              <StatItem
                icon={TreePine}
                iconColor="text-[hsl(var(--chart-2))]"
                label=""
                muted={!includeTree}
                value={treeTokensValue}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <TreeTokensTooltip includeTree={includeTree} />
          </TooltipContent>
        </Tooltip>

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
