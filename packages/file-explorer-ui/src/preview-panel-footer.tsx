import {
  Button,
  Label,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { ChevronDown, ChevronUp, Download, FileText } from 'lucide-react';
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import IncludeProjectTreeSetting from './include-project-tree-setting';
import {
  clampPreviewFooterHeight,
  getPreviewFooterModeHeight,
  PREVIEW_FOOTER_HEIGHTS,
  type PreviewFooterMode,
} from './preview-footer-layout';
import { TokenBudgetControl } from './token-budget-control';
import { TokenMeter } from './token-meter';
import { TokenSummaryBar } from './token-summary-bar';
import type { TokenCountingState } from './use-token-counting';

const FOOTER_INSIGHT_HISTORY_LIMIT = 24;
const SVG_ID_INVALID_CHARACTERS = /[^a-zA-Z0-9_-]/g;
const BODY_RESIZE_LOCKS_ATTRIBUTE = 'data-preview-footer-resize-locks';

function acquireBodyResizeLock(): void {
  if (typeof document === 'undefined') {
    return;
  }

  const locks = Number.parseInt(document.body.getAttribute(BODY_RESIZE_LOCKS_ATTRIBUTE) ?? '0', 10);
  const nextLocks = Number.isNaN(locks) ? 1 : locks + 1;

  if (nextLocks === 1) {
    document.body.classList.add('select-none', 'cursor-row-resize');
  }

  document.body.setAttribute(BODY_RESIZE_LOCKS_ATTRIBUTE, String(nextLocks));
}

function releaseBodyResizeLock(): void {
  if (typeof document === 'undefined') {
    return;
  }

  const locks = Number.parseInt(document.body.getAttribute(BODY_RESIZE_LOCKS_ATTRIBUTE) ?? '0', 10);

  if (Number.isNaN(locks) || locks <= 1) {
    document.body.removeAttribute(BODY_RESIZE_LOCKS_ATTRIBUTE);
    document.body.classList.remove('select-none', 'cursor-row-resize');
    return;
  }

  document.body.setAttribute(BODY_RESIZE_LOCKS_ATTRIBUTE, String(locks - 1));
}

interface TokenUsageSparklineProps {
  history: number[];
  budget: number;
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
  // Keep this defensive range logic in case upstream usage metrics emit temporary negatives.
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
    polylinePoints,
    areaPath,
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
  const deltaColorClassName =
    delta > 0
      ? 'text-amber-600 dark:text-amber-400'
      : delta < 0
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-muted-foreground';

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

interface TokenUsageMetrics {
  budget: number;
  selectedTokens: number;
  sourceSelectedTokens: number;
  includedTreeTokens: number;
  usedTokens: number;
  treePercent: number;
  selectedPercent: number;
  usedPercent: number;
  treeLabel: string;
  remainingLabel: string;
  isOverBudget: boolean;
  rangeAdjustedFilesCount: number;
  activeRangeFilesCount: number;
}

interface PreviewPanelFooterProps {
  totalFiles: number;
  tokenCounting: TokenCountingState;
  tokenUsage: TokenUsageMetrics;
  includeProjectTree: boolean;
  projectTreeUsesViewFilters: boolean;
  useTapestryRanges: boolean;
  treeLoading?: boolean;
  selectedTokensPendingCount?: number;
  onTokenBudgetChange?: ((budget: number) => void) | undefined;
  selectedFilesCount: number;
  onIncludeProjectTreeChange?: ((checked: boolean) => void) | undefined;
  onProjectTreeUsesViewFiltersChange?: ((checked: boolean) => void) | undefined;
  onUseTapestryRangesChange?: ((checked: boolean) => void) | undefined;
  onDownloadContext?: (() => void) | undefined;
  onCopyContext?: (() => void) | undefined;
  folderSummaryThreshold?: number;
  onFolderSummaryThresholdChange?: ((threshold: number) => void) | undefined;
  footerMode?: PreviewFooterMode;
  footerHeight?: number;
  footerCollapsed?: boolean;
  onFooterModeChange?: ((mode: PreviewFooterMode) => void) | undefined;
  onFooterHeightChange?: ((height: number) => void) | undefined;
  onFooterCollapsedChange?: ((collapsed: boolean) => void) | undefined;
}

interface DragSession {
  pointerId: number;
  startY: number;
  startHeight: number;
  handleElement: HTMLElement;
}

interface FooterActionButtonsProps {
  isCompact: boolean;
  selectedFilesCount: number;
  onDownloadContext?: (() => void) | undefined;
  onCopyContext?: (() => void) | undefined;
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
        aria-label="Compact footer mode"
        className={`rounded px-2 py-1 font-medium text-[11px] ${mode === 'compact' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
        onClick={() => onModeSelect('compact')}
        type="button"
      >
        Compact
      </button>
      <button
        aria-label="Balanced footer mode"
        className={`rounded px-2 py-1 font-medium text-[11px] ${mode === 'default' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
        onClick={() => onModeSelect('default')}
        type="button"
      >
        Balanced
      </button>
      <button
        aria-label="Insights footer mode"
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
  tokenUsage: TokenUsageMetrics;
  includeProjectTree: boolean;
  useTapestryRanges: boolean;
  usageHistory: number[];
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
        id: 'selected',
        label: useTapestryRanges ? 'Output' : 'Selected',
        value: tokenUsage.selectedTokens,
        visualValue: tokenUsage.selectedTokens * budgetRatio,
        className: 'bg-primary/80',
      },
      {
        id: 'tree',
        label: 'Tree',
        value: treeTokens,
        visualValue: treeTokens * budgetRatio,
        className: 'bg-[hsl(var(--chart-2))]/80',
      },
      {
        id: 'remaining',
        label: tokenUsage.isOverBudget ? 'Over budget' : 'Remaining',
        value: tokenUsage.isOverBudget ? overBudgetTokens : remainingTokens,
        visualValue: tokenUsage.isOverBudget ? overBudgetTokens : remainingTokens,
        className: tokenUsage.isOverBudget ? 'bg-destructive/75' : 'bg-emerald-500/70',
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
                width: `${segment.widthPercent}%`,
                minWidth: segment.value > 0 ? '4px' : undefined,
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
  tokenUsage: TokenUsageMetrics;
  onTokenBudgetChange?: ((budget: number) => void) | undefined;
  actions: ReactNode;
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
  includeProjectTree: boolean;
  projectTreeUsesViewFilters: boolean;
  useTapestryRanges: boolean;
  selectedFilesCount: number;
  tokenUsage: TokenUsageMetrics;
  folderSummaryThreshold: number;
  onTokenBudgetChange?: ((budget: number) => void) | undefined;
  onIncludeProjectTreeChange?: ((checked: boolean) => void) | undefined;
  onProjectTreeUsesViewFiltersChange?: ((checked: boolean) => void) | undefined;
  onFolderSummaryThresholdChange?: ((threshold: number) => void) | undefined;
  onUseTapestryRangesChange?: ((checked: boolean) => void) | undefined;
  actions: ReactNode;
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
              className="h-7 w-14 rounded-md border border-input bg-background px-1.5 text-center text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
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
      footerHeight = getPreviewFooterModeHeight('default'),
      footerCollapsed = false,
      onFooterModeChange,
      onFooterHeightChange,
      onFooterCollapsedChange,
    } = props;

    const [isResizing, setIsResizing] = useState(false);
    const [draftHeight, setDraftHeight] = useState<number | null>(null);
    const [usageHistory, setUsageHistory] = useState<number[]>([]);
    const usageHistoryRef = useRef<number[]>([]);
    const dragSessionRef = useRef<DragSession | null>(null);
    const queuedHeightRef = useRef<number>(clampPreviewFooterHeight(footerHeight));
    const animationFrameRef = useRef<number | null>(null);
    const hasBodyResizeLockRef = useRef(false);

    const committedHeight = clampPreviewFooterHeight(footerHeight);
    // Mode is driven exclusively by explicit button clicks, never inferred from height.
    const effectiveHeight = footerCollapsed
      ? PREVIEW_FOOTER_HEIGHTS.collapsed
      : (draftHeight ?? committedHeight);
    const effectiveMode = footerMode;
    const isCompact = effectiveMode === 'compact';
    const isExpanded = effectiveMode === 'expanded';
    const isExpandedRef = useRef(isExpanded);
    isExpandedRef.current = isExpanded;
    const usedTokensRef = useRef(tokenUsage.usedTokens);
    usedTokensRef.current = tokenUsage.usedTokens;

    const meterSize = isExpanded ? 'lg' : isCompact ? 'sm' : 'md';

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

    const releaseResizeLockIfHeld = useCallback(() => {
      if (!hasBodyResizeLockRef.current) {
        return;
      }

      releaseBodyResizeLock();
      hasBodyResizeLockRef.current = false;
    }, []);

    const commitHeight = useCallback(
      (height: number) => {
        const nextHeight = clampPreviewFooterHeight(height);

        if (onFooterHeightChange && nextHeight !== committedHeight) {
          onFooterHeightChange(nextHeight);
        }
      },
      [committedHeight, onFooterHeightChange]
    );
    const commitHeightRef = useRef(commitHeight);

    useEffect(() => {
      commitHeightRef.current = commitHeight;
    }, [commitHeight]);

    useEffect(() => {
      if (!isResizing) {
        return;
      }

      const handlePointerMove = (event: PointerEvent) => {
        const session = dragSessionRef.current;
        if (!session || event.pointerId !== session.pointerId) {
          return;
        }

        const deltaY = session.startY - event.clientY;
        queuedHeightRef.current = clampPreviewFooterHeight(session.startHeight + deltaY);

        if (animationFrameRef.current !== null) {
          return;
        }

        animationFrameRef.current = window.requestAnimationFrame(() => {
          animationFrameRef.current = null;
          // Coalesce rapid pointer moves into a single height update per animation frame.
          setDraftHeight(queuedHeightRef.current);
        });
      };

      const finishResize = (event?: Event) => {
        const session = dragSessionRef.current;
        if (event instanceof PointerEvent && session && event.pointerId !== session.pointerId) {
          return;
        }

        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        const finalHeight = queuedHeightRef.current;
        if (session?.handleElement.hasPointerCapture?.(session.pointerId)) {
          session.handleElement.releasePointerCapture?.(session.pointerId);
        }
        dragSessionRef.current = null;
        setIsResizing(false);
        setDraftHeight(null);
        releaseResizeLockIfHeld();
        commitHeightRef.current(finalHeight);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', finishResize);
      window.addEventListener('pointercancel', finishResize);
      window.addEventListener('blur', finishResize);

      return () => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', finishResize);
        window.removeEventListener('pointercancel', finishResize);
        window.removeEventListener('blur', finishResize);
        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        if (dragSessionRef.current) {
          dragSessionRef.current = null;
          releaseResizeLockIfHeld();
        }
      };
    }, [isResizing, releaseResizeLockIfHeld]);

    useEffect(() => {
      return () => {
        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        releaseResizeLockIfHeld();
      };
    }, [releaseResizeLockIfHeld]);

    const handleResizeStart = useCallback(
      (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) {
          return;
        }
        if (typeof document === 'undefined') {
          return;
        }

        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        if (!hasBodyResizeLockRef.current) {
          acquireBodyResizeLock();
          hasBodyResizeLockRef.current = true;
        }

        // When starting a resize from collapsed state, uncollapse and begin from min height.
        if (footerCollapsed) {
          onFooterCollapsedChange?.(false);
        }
        const startHeight = footerCollapsed ? PREVIEW_FOOTER_HEIGHTS.min : effectiveHeight;

        queuedHeightRef.current = startHeight;
        dragSessionRef.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startHeight,
          handleElement: event.currentTarget,
        };

        setDraftHeight(startHeight);
        setIsResizing(true);
      },
      [effectiveHeight, footerCollapsed, onFooterCollapsedChange]
    );

    const handleResizeKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLElement>) => {
        const baseHeight = isResizing ? queuedHeightRef.current : effectiveHeight;
        let nextHeight: number | null = null;

        switch (event.key) {
          case 'ArrowUp':
          case 'ArrowRight': {
            nextHeight = baseHeight + PREVIEW_FOOTER_HEIGHTS.resizeStep;
            break;
          }
          case 'ArrowDown':
          case 'ArrowLeft': {
            nextHeight = baseHeight - PREVIEW_FOOTER_HEIGHTS.resizeStep;
            break;
          }
          case 'Home': {
            nextHeight = getPreviewFooterModeHeight('compact');
            break;
          }
          case 'End': {
            nextHeight = PREVIEW_FOOTER_HEIGHTS.expanded;
            break;
          }
          default: {
            return;
          }
        }

        event.preventDefault();
        const clampedHeight = clampPreviewFooterHeight(nextHeight);
        queuedHeightRef.current = clampedHeight;
        commitHeight(clampedHeight);
      },
      [commitHeight, effectiveHeight, isResizing]
    );

    const applyMode = useCallback(
      (mode: PreviewFooterMode) => {
        const nextHeight = getPreviewFooterModeHeight(mode);
        queuedHeightRef.current = nextHeight;
        setDraftHeight(null);
        // Uncollapse when explicitly selecting a mode.
        if (footerCollapsed) {
          onFooterCollapsedChange?.(false);
        }
        onFooterModeChange?.(mode);
        onFooterHeightChange?.(nextHeight);
      },
      [footerCollapsed, onFooterCollapsedChange, onFooterModeChange, onFooterHeightChange]
    );

    const handleCollapseToggle = useCallback(() => {
      onFooterCollapsedChange?.(!footerCollapsed);
    }, [footerCollapsed, onFooterCollapsedChange]);

    return (
      <div
        className={`@container relative flex flex-shrink-0 flex-col overflow-hidden border-t bg-background/95 supports-[backdrop-filter]:bg-background/80 ${
          isResizing ? '' : 'transition-[height] duration-200 ease-out'
        }`}
        style={{
          height: `${effectiveHeight}px`,
        }}
      >
        <div className="flex h-7 flex-shrink-0 items-center gap-2 border-b bg-muted/20 px-2">
          <button
            aria-label={footerCollapsed ? 'Expand footer' : 'Collapse footer'}
            className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={handleCollapseToggle}
            type="button"
          >
            {footerCollapsed ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </button>

          <hr
            aria-label="Resize context explorer footer"
            aria-orientation="horizontal"
            aria-roledescription="resize handle"
            aria-valuemax={PREVIEW_FOOTER_HEIGHTS.max}
            aria-valuemin={PREVIEW_FOOTER_HEIGHTS.min}
            aria-valuenow={footerCollapsed ? PREVIEW_FOOTER_HEIGHTS.collapsed : effectiveHeight}
            className="h-1 flex-1 cursor-row-resize touch-none rounded-full border-0 bg-border outline-none transition-colors hover:bg-primary/40 focus-visible:ring-2 focus-visible:ring-ring"
            onKeyDown={handleResizeKeyDown}
            onPointerDown={handleResizeStart}
            tabIndex={0}
          />

          <FooterModeButtons mode={effectiveMode} onModeSelect={applyMode} />
        </div>

        {!footerCollapsed && (
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-3">
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

            {isExpanded && (
              <ExpandedFooterInsights
                includeProjectTree={includeProjectTree}
                tokenUsage={tokenUsage}
                usageHistory={usageHistory}
                useTapestryRanges={useTapestryRanges}
              />
            )}

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
        )}
      </div>
    );
  }
);

PreviewPanelFooter.displayName = 'PreviewPanelFooter';

export type { TokenUsageMetrics };
