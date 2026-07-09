import {
  Button,
  Label,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { Download, FileText } from 'lucide-react';
import { memo, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import IncludeProjectTreeSetting from '../include-project-tree-setting';
import { TokenBudgetControl } from '../indexing/token-budget-control';
import { TokenMeter } from '../indexing/token-meter';
import { TokenSummaryBar } from '../indexing/token-summary-bar';
import type { TokenCountingState } from '../indexing/use-token-counting';
import type { PreviewFooterMode } from './preview-footer-layout';

const FOOTER_INSIGHT_HISTORY_LIMIT = 24;
const SVG_ID_INVALID_CHARACTERS = /[^a-zA-Z0-9_-]/g;
const noop = (): void => {};

interface TokenUsageSparklineProps {
  budget: number;
  history: number[];
  isOverBudget: boolean;
}

function buildSparklinePoints(
  history: number[],
  budget: number
): { polylinePoints: string; areaPath: string } | null {
  if (history.length < 2) {
    return null;
  }

  const width = 220;
  const height = 36;
  const padding = 4;
  let maxValue = Math.max(1, budget);
  let minValue = 0;
  // Keep this defensive range logic in case upstream usage metrics emit transient negatives.
  for (const value of history) {
    if (value > maxValue) {
      maxValue = value;
    }
    if (value < minValue) {
      minValue = value;
    }
  }
  const valueRange = Math.max(1, maxValue - minValue);
  const xStep = (width - padding * 2) / (history.length - 1);

  const points = history.map((value, index) => {
    const x = padding + index * xStep;
    const normalized = (value - minValue) / valueRange;
    const y = height - padding - normalized * (height - padding * 2);
    return { x, y };
  });

  const pathSegments: string[] = [];
  const lineCommands: string[] = [];
  for (const point of points) {
    pathSegments.push(`${point.x},${point.y}`);
    lineCommands.push(`L ${point.x} ${point.y}`);
  }
  const polylinePoints = pathSegments.join(' ');
  const firstPoint = points[0];
  const lastPoint = points.at(-1);
  if (firstPoint === undefined || lastPoint === undefined) {
    return null;
  }
  const areaPath = `M ${firstPoint.x} ${height - padding} ${lineCommands.join(' ')} L ${lastPoint.x} ${height - padding} Z`;

  return {
    areaPath,
    polylinePoints,
  };
}

const TokenUsageSparkline = memo<TokenUsageSparklineProps>(function TokenUsageSparkline({
  history,
  budget,
  isOverBudget,
}) {
  const geometry = useMemo(() => buildSparklinePoints(history, budget), [history, budget]);
  const gradientId = useId();
  const gradientFillId = `footer-usage-fill-${gradientId.replace(SVG_ID_INVALID_CHARACTERS, '') || 'usage'}`;
  const latest = history.at(-1) ?? 0;
  const previous = history.at(-2) ?? latest;
  const delta = latest - previous;
  let deltaColorClassName = 'text-muted-foreground';
  if (delta > 0) {
    deltaColorClassName = 'text-amber-600 dark:text-amber-400';
  } else if (delta < 0) {
    deltaColorClassName = 'text-emerald-600 dark:text-emerald-400';
  }

  return (
    <div className="rounded-md border bg-background/60 p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
          Usage trend
        </span>
        <span className={`font-medium text-xs tabular-nums ${deltaColorClassName}`}>
          {delta > 0 ? '+' : ''}
          {delta.toLocaleString()}
        </span>
      </div>
      {geometry ? (
        <svg aria-hidden="true" className="h-9 w-full" viewBox="0 0 220 36">
          <defs>
            <linearGradient id={gradientFillId} x1="0" x2="0" y1="0" y2="1">
              <stop
                offset="0%"
                stopColor={isOverBudget ? 'hsl(var(--destructive))' : 'hsl(var(--primary))'}
                stopOpacity="0.28"
              />
              <stop
                offset="100%"
                stopColor={isOverBudget ? 'hsl(var(--destructive))' : 'hsl(var(--primary))'}
                stopOpacity="0.04"
              />
            </linearGradient>
          </defs>
          <path d={geometry.areaPath} fill={`url(#${gradientFillId})`} />
          <polyline
            fill="none"
            points={geometry.polylinePoints}
            stroke={isOverBudget ? 'hsl(var(--destructive))' : 'hsl(var(--primary))'}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          />
        </svg>
      ) : (
        <div className="flex h-9 items-center justify-center text-[11px] text-muted-foreground">
          Select files to build usage history
        </div>
      )}
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{latest.toLocaleString()} current</span>
        <span>{Math.round((latest / Math.max(budget, 1)) * 100)}% of budget</span>
      </div>
    </div>
  );
});

export interface TokenUsageMetrics {
  activeRangeFilesCount: number;
  budget: number;
  includedTreeTokens: number;
  isOverBudget: boolean;
  rangeAdjustedFilesCount: number;
  remainingLabel: string;
  selectedPercent: number;
  selectedTokens: number;
  sourceSelectedTokens: number;
  treeLabel: string;
  treePercent: number;
  usedPercent: number;
  usedTokens: number;
}

interface PreviewPanelFooterProps {
  folderSummaryThreshold?: number;
  footerMode?: PreviewFooterMode;
  includeProjectTree: boolean;
  onCopyContext?: (() => void) | undefined;
  onDownloadContext?: (() => void) | undefined;
  onFolderSummaryThresholdChange?: ((threshold: number) => void) | undefined;
  onFooterModeChange?: ((mode: PreviewFooterMode) => void) | undefined;
  onIncludeProjectTreeChange?: ((checked: boolean) => void) | undefined;
  onProjectTreeUsesViewFiltersChange?: ((checked: boolean) => void) | undefined;
  onTokenBudgetChange?: ((budget: number) => void) | undefined;
  onUseTapestryRangesChange?: ((checked: boolean) => void) | undefined;
  projectTreeUsesViewFilters: boolean;
  selectedFilesCount: number;
  /** BST-153: Number of files still being indexed (for "estimating..." state) */
  selectedTokensPendingCount?: number;
  tokenCounting: TokenCountingState;
  tokenUsage: TokenUsageMetrics;
  totalFiles: number;
  treeLoading?: boolean;
  useTapestryRanges: boolean;
}

interface FooterActionButtonsProps {
  isCompact: boolean;
  onCopyContext?: (() => void) | undefined;
  onDownloadContext?: (() => void) | undefined;
  selectedFilesCount: number;
}

const FooterActionButtons = memo<FooterActionButtonsProps>(function FooterActionButtons({
  isCompact,
  selectedFilesCount,
  onDownloadContext,
  onCopyContext,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <TooltipProvider delayDuration={400}>
        {onDownloadContext && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={
                  selectedFilesCount === 0
                    ? 'Download Context (no files selected)'
                    : 'Download Context'
                }
                className={isCompact ? 'h-7 px-2' : '@[600px]:h-9 h-8 @[600px]:px-3 px-2'}
                data-testid="download-context-button"
                disabled={selectedFilesCount === 0}
                onClick={onDownloadContext}
                size="sm"
                variant="outline"
              >
                <Download className={isCompact ? 'size-3.5' : '@[600px]:mr-2 size-3.5'} />
                {!isCompact && (
                  <>
                    <span className="@[700px]:inline hidden">Download Context</span>
                    <span className="@[500px]:inline @[700px]:hidden hidden">Download</span>
                  </>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download context as file</TooltipContent>
          </Tooltip>
        )}
        {onCopyContext && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={
                  selectedFilesCount === 0 ? 'Copy Context (no files selected)' : 'Copy Context'
                }
                className={isCompact ? 'h-7 px-2' : '@[600px]:h-9 h-8 @[600px]:px-3 px-2'}
                data-testid="copy-context-button"
                disabled={selectedFilesCount === 0}
                onClick={onCopyContext}
                size="sm"
                variant="outline"
              >
                <FileText className={isCompact ? 'size-3.5' : '@[600px]:mr-2 size-3.5'} />
                {!isCompact && (
                  <>
                    <span className="@[700px]:inline hidden">Copy Context</span>
                    <span className="@[500px]:inline @[700px]:hidden hidden">Copy</span>
                  </>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy context to clipboard</TooltipContent>
          </Tooltip>
        )}
      </TooltipProvider>
    </div>
  );
});

interface FooterModeButtonsProps {
  mode: PreviewFooterMode;
  onModeSelect: (mode: PreviewFooterMode) => void;
}

const FooterModeButtons = memo<FooterModeButtonsProps>(function FooterModeButtons({
  mode,
  onModeSelect,
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border bg-background/80 p-0.5">
      <button
        aria-label="Compact summary mode"
        aria-pressed={mode === 'compact'}
        className={`rounded px-2 py-1 font-medium text-[11px] ${mode === 'compact' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
        onClick={() => onModeSelect('compact')}
        type="button"
      >
        Compact
      </button>
      <button
        aria-label="Balanced summary mode"
        aria-pressed={mode === 'default'}
        className={`rounded px-2 py-1 font-medium text-[11px] ${mode === 'default' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
        onClick={() => onModeSelect('default')}
        type="button"
      >
        Balanced
      </button>
      <button
        aria-label="Insights summary mode"
        aria-pressed={mode === 'expanded'}
        className={`rounded px-2 py-1 font-medium text-[11px] ${mode === 'expanded' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
        onClick={() => onModeSelect('expanded')}
        type="button"
      >
        Insights
      </button>
    </div>
  );
});

interface ExpandedFooterInsightsProps {
  includeProjectTree: boolean;
  tokenUsage: TokenUsageMetrics;
  usageHistory: number[];
  useTapestryRanges: boolean;
}

const ExpandedFooterInsights = memo<ExpandedFooterInsightsProps>(function ExpandedFooterInsights({
  tokenUsage,
  includeProjectTree,
  useTapestryRanges,
  usageHistory,
}) {
  const compositionSegments = useMemo(() => {
    const treeTokens = includeProjectTree ? tokenUsage.includedTreeTokens : 0;
    const totalUsedTokens = Math.max(0, tokenUsage.usedTokens);
    const overBudgetTokens = Math.max(0, totalUsedTokens - tokenUsage.budget);
    const remainingTokens = Math.max(0, tokenUsage.budget - totalUsedTokens);
    const budgetRatio = totalUsedTokens > 0 ? Math.min(1, tokenUsage.budget / totalUsedTokens) : 1;

    const segments = [
      {
        className: 'bg-primary/80',
        id: 'selected',
        label: useTapestryRanges ? 'Output' : 'Selected',
        value: tokenUsage.selectedTokens,
        visualValue: tokenUsage.selectedTokens * budgetRatio,
      },
      {
        className: 'bg-[hsl(var(--chart-2))]/80',
        id: 'tree',
        label: 'Tree',
        value: treeTokens,
        visualValue: treeTokens * budgetRatio,
      },
      {
        className: tokenUsage.isOverBudget ? 'bg-destructive/75' : 'bg-emerald-500/70',
        id: 'remaining',
        label: tokenUsage.isOverBudget ? 'Over budget' : 'Remaining',
        value: tokenUsage.isOverBudget ? overBudgetTokens : remainingTokens,
        visualValue: tokenUsage.isOverBudget ? overBudgetTokens : remainingTokens,
      },
    ];
    const totalValue = Math.max(1, tokenUsage.isOverBudget ? totalUsedTokens : tokenUsage.budget);

    return segments.map((segment) => ({
      ...segment,
      widthPercent: (segment.visualValue / totalValue) * 100,
    }));
  }, [includeProjectTree, tokenUsage, useTapestryRanges]);

  return (
    <div className="grid @[640px]:grid-cols-[1.2fr_0.8fr] gap-1.5">
      <div className="rounded-md border bg-gradient-to-br from-muted/35 via-background to-background p-2">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
            Budget composition
          </span>
          <span className="font-medium text-foreground text-xs tabular-nums">
            {tokenUsage.usedTokens.toLocaleString()} / {tokenUsage.budget.toLocaleString()}
          </span>
        </div>
        <div aria-hidden className="mb-1.5 flex h-2.5 overflow-hidden rounded-sm bg-muted">
          {compositionSegments.map((segment) => (
            <div
              className={segment.className}
              key={segment.id}
              style={{
                minWidth: segment.value > 0 ? '4px' : undefined,
                width: `${segment.widthPercent}%`,
              }}
            />
          ))}
        </div>
        <div className="grid grid-cols-3 gap-1 text-[11px]">
          {compositionSegments.map((segment) => (
            <div className="flex items-center justify-between gap-2" key={segment.id}>
              <span className="text-muted-foreground">{segment.label}</span>
              <span className="font-medium tabular-nums">{segment.value.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>

      <TokenUsageSparkline
        budget={tokenUsage.budget}
        history={usageHistory}
        isOverBudget={tokenUsage.isOverBudget}
      />
    </div>
  );
});

interface CompactFooterControlsProps {
  actions: ReactNode;
  onTokenBudgetChange?: ((budget: number) => void) | undefined;
  tokenUsage: TokenUsageMetrics;
}

const CompactFooterControls = memo<CompactFooterControlsProps>(function CompactFooterControls({
  tokenUsage,
  onTokenBudgetChange,
  actions,
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
      <div className="flex items-center gap-2">
        <TokenBudgetControl
          budget={tokenUsage.budget}
          compact
          onBudgetChange={onTokenBudgetChange}
        />
        <span
          className={`rounded px-2 py-1 font-medium text-[11px] tabular-nums ${tokenUsage.isOverBudget ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}`}
        >
          {tokenUsage.remainingLabel}
        </span>
      </div>
      {actions}
    </div>
  );
});

interface DetailedFooterControlsProps {
  actions: ReactNode;
  folderSummaryThreshold: number;
  includeProjectTree: boolean;
  onFolderSummaryThresholdChange?: ((threshold: number) => void) | undefined;
  onIncludeProjectTreeChange?: ((checked: boolean) => void) | undefined;
  onProjectTreeUsesViewFiltersChange?: ((checked: boolean) => void) | undefined;
  onTokenBudgetChange?: ((budget: number) => void) | undefined;
  onUseTapestryRangesChange?: ((checked: boolean) => void) | undefined;
  projectTreeUsesViewFilters: boolean;
  selectedFilesCount: number;
  tokenUsage: TokenUsageMetrics;
  useTapestryRanges: boolean;
}

const DetailedFooterControls = memo<DetailedFooterControlsProps>(function DetailedFooterControls({
  includeProjectTree,
  projectTreeUsesViewFilters,
  useTapestryRanges,
  selectedFilesCount,
  tokenUsage,
  folderSummaryThreshold,
  onTokenBudgetChange,
  onIncludeProjectTreeChange,
  onProjectTreeUsesViewFiltersChange,
  onFolderSummaryThresholdChange,
  onUseTapestryRangesChange,
  actions,
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-2.5">
      <TokenBudgetControl budget={tokenUsage.budget} onBudgetChange={onTokenBudgetChange} />

      {onIncludeProjectTreeChange && <div aria-hidden className="h-6 w-px bg-border" />}

      {onIncludeProjectTreeChange && (
        <div className="flex items-center gap-2">
          <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-2">
                  <IncludeProjectTreeSetting
                    checked={includeProjectTree}
                    onChange={onIncludeProjectTreeChange}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>Include project tree in the context</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}

      {includeProjectTree && onProjectTreeUsesViewFiltersChange && (
        <>
          <div aria-hidden className="h-6 w-px bg-border" />
          <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-2">
                  <Switch
                    aria-label="Use filtered project tree"
                    checked={projectTreeUsesViewFilters}
                    id="project-tree-uses-view-filters"
                    onCheckedChange={onProjectTreeUsesViewFiltersChange}
                  />
                  <Label
                    className="cursor-pointer select-none text-muted-foreground text-xs"
                    htmlFor="project-tree-uses-view-filters"
                  >
                    Use Filtered Tree
                  </Label>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                Toggle filtered tree output. Applies when Include Project Tree is on.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </>
      )}

      {includeProjectTree && onFolderSummaryThresholdChange && (
        <>
          <div aria-hidden className="h-6 w-px bg-border" />
          <div className="flex items-center gap-2">
            <label
              className="whitespace-nowrap text-muted-foreground text-xs"
              htmlFor="folder-summary-threshold-footer"
              title="Number of files shown per folder in the project tree before summarizing. Set to 0 to show all."
            >
              Tree detail:
            </label>
            <input
              className="h-7 w-14 rounded-md border border-input bg-background px-1.5 text-center text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              id="folder-summary-threshold-footer"
              min="0"
              onChange={(event) => {
                const value = Number.parseInt(event.target.value, 10);
                if (!Number.isNaN(value) && value >= 0) {
                  onFolderSummaryThresholdChange(value);
                }
              }}
              title="Files per folder before summarizing (0 = show all)"
              type="number"
              value={folderSummaryThreshold}
            />
          </div>
        </>
      )}

      {onUseTapestryRangesChange && (
        <>
          <div aria-hidden className="h-6 w-px bg-border" />
          <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-2">
                  <Switch
                    aria-label="Use tapestry ranges in context output"
                    checked={useTapestryRanges}
                    disabled={selectedFilesCount === 0}
                    id="use-tapestry-ranges"
                    onCheckedChange={onUseTapestryRangesChange}
                  />
                  <Label
                    className="cursor-pointer select-none text-muted-foreground text-xs"
                    htmlFor="use-tapestry-ranges"
                  >
                    Use Tapestry Ranges
                  </Label>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                When enabled, export only active ranges. Turn off for full files.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </>
      )}

      <div className="flex-1" />
      {actions}
    </div>
  );
});

export const PreviewPanelFooter = memo<PreviewPanelFooterProps>(
  function PreviewPanelFooterComponent(props) {
    const {
      totalFiles,
      tokenCounting,
      tokenUsage,
      includeProjectTree,
      projectTreeUsesViewFilters,
      useTapestryRanges,
      treeLoading = false,
      selectedTokensPendingCount = 0,
      onTokenBudgetChange,
      selectedFilesCount,
      onIncludeProjectTreeChange,
      onProjectTreeUsesViewFiltersChange,
      onUseTapestryRangesChange,
      onDownloadContext,
      onCopyContext,
      folderSummaryThreshold = 5,
      onFolderSummaryThresholdChange,
      footerMode = 'default',
      onFooterModeChange,
    } = props;

    const [usageHistory, setUsageHistory] = useState<number[]>([]);
    const usageHistoryRef = useRef<number[]>([]);
    const isCompact = footerMode === 'compact';
    const isExpanded = footerMode === 'expanded';
    const isExpandedRef = useRef(isExpanded);
    isExpandedRef.current = isExpanded;
    const usedTokensRef = useRef(tokenUsage.usedTokens);
    usedTokensRef.current = tokenUsage.usedTokens;

    let meterSize: 'sm' | 'md' | 'lg' = 'md';
    if (isExpanded) {
      meterSize = 'lg';
    } else if (isCompact) {
      meterSize = 'sm';
    }

    const averageTokensPerFile = useMemo(() => {
      if (selectedFilesCount <= 0) {
        return 0;
      }
      return tokenUsage.selectedTokens / selectedFilesCount;
    }, [selectedFilesCount, tokenUsage.selectedTokens]);

    const remainingTokens = tokenUsage.budget - tokenUsage.usedTokens;
    const estimatedAdditionalFiles =
      averageTokensPerFile > 0 && remainingTokens > 0
        ? Math.floor(remainingTokens / averageTokensPerFile)
        : 0;

    useEffect(() => {
      const previousHistory = usageHistoryRef.current;
      const latest = previousHistory.at(-1);
      if (latest === tokenUsage.usedTokens) {
        return;
      }

      const nextHistory = [...previousHistory, tokenUsage.usedTokens];
      usageHistoryRef.current =
        nextHistory.length <= FOOTER_INSIGHT_HISTORY_LIMIT
          ? nextHistory
          : nextHistory.slice(-FOOTER_INSIGHT_HISTORY_LIMIT);

      if (isExpandedRef.current) {
        setUsageHistory(usageHistoryRef.current);
      }
    }, [tokenUsage.usedTokens]);

    useEffect(() => {
      if (!isExpanded) {
        return;
      }

      if (usageHistoryRef.current.length === 0) {
        usageHistoryRef.current = [usedTokensRef.current];
      }
      setUsageHistory(usageHistoryRef.current);
    }, [isExpanded]);

    return (
      <div className="@container flex flex-shrink-0 flex-col border-b bg-background/95 supports-[backdrop-filter]:bg-background/80">
        <div className="flex flex-wrap items-center justify-end gap-2 border-b bg-muted/20 px-3 py-2">
          <FooterModeButtons mode={footerMode} onModeSelect={onFooterModeChange ?? noop} />
        </div>

        <div className="flex flex-col gap-2.5 p-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex flex-shrink-0 items-center">
              <TokenMeter
                budget={tokenUsage.budget}
                includeTree={includeProjectTree}
                isOverBudget={tokenUsage.isOverBudget}
                selectedTokens={tokenUsage.selectedTokens}
                size={meterSize}
                sourceSelectedTokens={tokenUsage.sourceSelectedTokens}
                treeTokens={tokenUsage.includedTreeTokens}
                usedTokens={tokenUsage.usedTokens}
                useTapestryRanges={useTapestryRanges}
              />
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <TokenSummaryBar
                activeRangeFilesCount={tokenUsage.activeRangeFilesCount}
                budget={tokenUsage.budget}
                includeTree={includeProjectTree}
                isOverBudget={tokenUsage.isOverBudget}
                rangeAdjustedFilesCount={tokenUsage.rangeAdjustedFilesCount}
                selectedTokens={tokenUsage.selectedTokens}
                selectedTokensPendingCount={selectedTokensPendingCount}
                sourceSelectedTokens={tokenUsage.sourceSelectedTokens}
                tokenCounting={tokenCounting}
                totalFiles={totalFiles}
                treeLoading={treeLoading}
                treeTokens={tokenUsage.includedTreeTokens}
                useTapestryRanges={useTapestryRanges}
              />

              {!isCompact && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>
                    <span className="font-medium text-foreground tabular-nums">
                      {Math.round(tokenUsage.usedPercent)}%
                    </span>{' '}
                    budget used
                  </span>
                  <span>
                    <span className="font-medium text-foreground tabular-nums">
                      {averageTokensPerFile > 0
                        ? Math.round(averageTokensPerFile).toLocaleString()
                        : '0'}
                    </span>{' '}
                    avg tokens per file
                  </span>
                  <span>
                    <span className="font-medium text-foreground tabular-nums">
                      {estimatedAdditionalFiles.toLocaleString()}
                    </span>{' '}
                    files fit at current density
                  </span>
                </div>
              )}
            </div>
          </div>

          {isExpanded ? (
            <ExpandedFooterInsights
              includeProjectTree={includeProjectTree}
              tokenUsage={tokenUsage}
              usageHistory={usageHistory}
              useTapestryRanges={useTapestryRanges}
            />
          ) : null}

          {isCompact ? (
            <CompactFooterControls
              actions={
                <FooterActionButtons
                  isCompact
                  onCopyContext={onCopyContext}
                  onDownloadContext={onDownloadContext}
                  selectedFilesCount={selectedFilesCount}
                />
              }
              onTokenBudgetChange={onTokenBudgetChange}
              tokenUsage={tokenUsage}
            />
          ) : (
            <DetailedFooterControls
              actions={
                <FooterActionButtons
                  isCompact={false}
                  onCopyContext={onCopyContext}
                  onDownloadContext={onDownloadContext}
                  selectedFilesCount={selectedFilesCount}
                />
              }
              folderSummaryThreshold={folderSummaryThreshold}
              includeProjectTree={includeProjectTree}
              onFolderSummaryThresholdChange={onFolderSummaryThresholdChange}
              onIncludeProjectTreeChange={onIncludeProjectTreeChange}
              onProjectTreeUsesViewFiltersChange={onProjectTreeUsesViewFiltersChange}
              onTokenBudgetChange={onTokenBudgetChange}
              onUseTapestryRangesChange={onUseTapestryRangesChange}
              projectTreeUsesViewFilters={projectTreeUsesViewFilters}
              selectedFilesCount={selectedFilesCount}
              tokenUsage={tokenUsage}
              useTapestryRanges={useTapestryRanges}
            />
          )}
        </div>
      </div>
    );
  }
);

PreviewPanelFooter.displayName = 'PreviewPanelFooter';
