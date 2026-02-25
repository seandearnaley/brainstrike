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
  inferPreviewFooterMode,
  PREVIEW_FOOTER_HEIGHTS,
  type PreviewFooterMode,
} from './preview-footer-layout';
import { TokenBudgetControl } from './token-budget-control';
import { TokenMeter } from './token-meter';
import { TokenSummaryBar } from './token-summary-bar';
import type { TokenCountingState } from './use-token-counting';

const FOOTER_INSIGHT_HISTORY_LIMIT = 24;

interface TokenUsageSparklineProps {
  history: number[];
  budget: number;
  isOverBudget: boolean;
}

function buildSparklinePoints(
  history: number[],
  budget: number
): { path: string; areaPath: string; maxValue: number; minValue: number } | null {
  if (history.length < 2) {
    return null;
  }

  const width = 220;
  const height = 48;
  const padding = 4;
  const maxValue = Math.max(1, budget, ...history);
  const minValue = Math.min(0, ...history);
  const valueRange = Math.max(1, maxValue - minValue);
  const xStep = (width - padding * 2) / (history.length - 1);

  const points = history.map((value, index) => {
    const x = padding + index * xStep;
    const normalized = (value - minValue) / valueRange;
    const y = height - padding - normalized * (height - padding * 2);
    return { x, y };
  });

  const path = points.map((point) => `${point.x},${point.y}`).join(' ');
  const lineCommands = points.map((point) => `L ${point.x} ${point.y}`).join(' ');
  const firstPoint = points[0];
  const lastPoint = points.at(-1);

  if (!(firstPoint && lastPoint)) {
    return null;
  }

  const areaPath = `M ${firstPoint.x} ${height - padding} ${lineCommands} L ${lastPoint.x} ${height - padding} Z`;

  return {
    path,
    areaPath,
    maxValue,
    minValue,
  };
}

const TokenUsageSparkline = memo<TokenUsageSparklineProps>(function TokenUsageSparkline({
  history,
  budget,
  isOverBudget,
}) {
  const geometry = useMemo(() => buildSparklinePoints(history, budget), [history, budget]);
  const gradientId = useId();
  const gradientFillId = `footer-usage-fill-${gradientId.replaceAll(':', '')}`;
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
        <svg aria-hidden="true" className="h-12 w-full" viewBox="0 0 220 48">
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
            points={geometry.path}
            stroke={isOverBudget ? 'hsl(var(--destructive))' : 'hsl(var(--primary))'}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          />
        </svg>
      ) : (
        <div className="flex h-12 items-center justify-center text-[11px] text-muted-foreground">
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
  onFooterModeChange?: ((mode: PreviewFooterMode) => void) | undefined;
  onFooterHeightChange?: ((height: number) => void) | undefined;
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
    const segments = [
      {
        id: 'selected',
        label: useTapestryRanges ? 'Output' : 'Selected',
        value: tokenUsage.selectedTokens,
        className: 'bg-primary/80',
      },
      {
        id: 'tree',
        label: 'Tree',
        value: includeProjectTree ? tokenUsage.includedTreeTokens : 0,
        className: 'bg-[hsl(var(--chart-2))]/80',
      },
      {
        id: 'remaining',
        label: tokenUsage.isOverBudget ? 'Over budget' : 'Remaining',
        value: Math.abs(tokenUsage.budget - tokenUsage.usedTokens),
        className: tokenUsage.isOverBudget ? 'bg-destructive/75' : 'bg-emerald-500/70',
      },
    ];
    const totalValue = Math.max(
      1,
      segments.reduce((sum, segment) => sum + segment.value, 0)
    );

    return segments.map((segment) => ({
      ...segment,
      widthPercent: (segment.value / totalValue) * 100,
    }));
  }, [includeProjectTree, tokenUsage, useTapestryRanges]);

  return (
    <div className="grid @[980px]:grid-cols-[1.2fr_0.8fr] gap-2">
      <div className="rounded-md border bg-gradient-to-br from-muted/35 via-background to-background p-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
            Budget composition
          </span>
          <span className="font-medium text-foreground text-xs tabular-nums">
            {tokenUsage.usedTokens.toLocaleString()} / {tokenUsage.budget.toLocaleString()}
          </span>
        </div>
        <div aria-hidden className="mb-2 flex h-3 overflow-hidden rounded-sm bg-muted">
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
        <div className="grid @[760px]:grid-cols-3 grid-cols-1 gap-1 text-[11px]">
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
      onFooterModeChange,
      onFooterHeightChange,
    } = props;

    const [isResizing, setIsResizing] = useState(false);
    const [draftHeight, setDraftHeight] = useState<number | null>(null);
    const [usageHistory, setUsageHistory] = useState<number[]>([tokenUsage.usedTokens]);
    const dragSessionRef = useRef<DragSession | null>(null);
    const queuedHeightRef = useRef<number>(clampPreviewFooterHeight(footerHeight));
    const animationFrameRef = useRef<number | null>(null);
    const previousBodyStylesRef = useRef<{ userSelect: string; cursor: string } | null>(null);

    const committedHeight = clampPreviewFooterHeight(footerHeight);
    const effectiveHeight = draftHeight ?? committedHeight;
    const effectiveMode = draftHeight !== null ? inferPreviewFooterMode(draftHeight) : footerMode;
    const isCompact = effectiveMode === 'compact';
    const isExpanded = effectiveMode === 'expanded';

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
      setUsageHistory((previousHistory) => {
        const latest = previousHistory.at(-1);
        if (latest === tokenUsage.usedTokens) {
          return previousHistory;
        }

        const nextHistory = [...previousHistory, tokenUsage.usedTokens];
        if (nextHistory.length <= FOOTER_INSIGHT_HISTORY_LIMIT) {
          return nextHistory;
        }

        return nextHistory.slice(-FOOTER_INSIGHT_HISTORY_LIMIT);
      });
    }, [tokenUsage.usedTokens]);

    const restoreBodyStyles = useCallback(() => {
      if (typeof document === 'undefined') {
        return;
      }
      if (!previousBodyStylesRef.current) {
        return;
      }

      document.body.style.userSelect = previousBodyStylesRef.current.userSelect;
      document.body.style.cursor = previousBodyStylesRef.current.cursor;
      previousBodyStylesRef.current = null;
    }, []);

    const commitHeight = useCallback(
      (height: number) => {
        const nextHeight = clampPreviewFooterHeight(height);
        const nextMode = inferPreviewFooterMode(nextHeight);

        if (onFooterHeightChange && nextHeight !== committedHeight) {
          onFooterHeightChange(nextHeight);
        }

        if (onFooterModeChange && nextMode !== footerMode) {
          onFooterModeChange(nextMode);
        }
      },
      [committedHeight, footerMode, onFooterHeightChange, onFooterModeChange]
    );

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
        restoreBodyStyles();
        commitHeight(finalHeight);
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
          restoreBodyStyles();
        }
      };
    }, [commitHeight, isResizing, restoreBodyStyles]);

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

        if (previousBodyStylesRef.current === null) {
          previousBodyStylesRef.current = {
            userSelect: document.body.style.userSelect,
            cursor: document.body.style.cursor,
          };
        }

        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'row-resize';

        queuedHeightRef.current = effectiveHeight;
        dragSessionRef.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startHeight: effectiveHeight,
          handleElement: event.currentTarget,
        };

        setDraftHeight(effectiveHeight);
        setIsResizing(true);
      },
      [effectiveHeight]
    );

    const handleResizeKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLElement>) => {
        let nextHeight: number | null = null;

        switch (event.key) {
          case 'ArrowUp':
          case 'ArrowRight': {
            nextHeight = effectiveHeight + PREVIEW_FOOTER_HEIGHTS.resizeStep;
            break;
          }
          case 'ArrowDown':
          case 'ArrowLeft': {
            nextHeight = effectiveHeight - PREVIEW_FOOTER_HEIGHTS.resizeStep;
            break;
          }
          case 'Home': {
            nextHeight = getPreviewFooterModeHeight('compact');
            break;
          }
          case 'End': {
            nextHeight = getPreviewFooterModeHeight('expanded');
            break;
          }
          default: {
            return;
          }
        }

        event.preventDefault();
        commitHeight(nextHeight);
      },
      [commitHeight, effectiveHeight]
    );

    const applyMode = useCallback(
      (mode: PreviewFooterMode) => {
        const nextHeight = getPreviewFooterModeHeight(mode);
        queuedHeightRef.current = nextHeight;
        setDraftHeight(null);

        if (onFooterModeChange && mode !== footerMode) {
          onFooterModeChange(mode);
        }

        if (onFooterHeightChange && nextHeight !== committedHeight) {
          onFooterHeightChange(nextHeight);
        }
      },
      [committedHeight, footerMode, onFooterHeightChange, onFooterModeChange]
    );

    return (
      <div
        className={`@container relative flex flex-shrink-0 flex-col overflow-hidden border-t bg-background/95 supports-[backdrop-filter]:bg-background/80 ${
          isResizing ? '' : 'transition-[height] duration-200 ease-out'
        }`}
        style={{
          height: `${effectiveHeight}px`,
          willChange: isResizing ? 'height' : undefined,
        }}
      >
        <div className="flex h-7 items-center gap-2 border-b bg-muted/20 px-2">
          <hr
            aria-label="Resize context explorer footer"
            aria-orientation="horizontal"
            aria-valuemax={PREVIEW_FOOTER_HEIGHTS.max}
            aria-valuemin={PREVIEW_FOOTER_HEIGHTS.min}
            aria-valuenow={effectiveHeight}
            className="h-1 flex-1 cursor-row-resize touch-none rounded-full border-0 bg-border outline-none transition-colors hover:bg-primary/40 focus-visible:ring-2 focus-visible:ring-ring"
            onKeyDown={handleResizeKeyDown}
            onPointerDown={handleResizeStart}
            tabIndex={0}
          />

          <FooterModeButtons mode={effectiveMode} onModeSelect={applyMode} />
        </div>

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
      </div>
    );
  }
);

PreviewPanelFooter.displayName = 'PreviewPanelFooter';

export type { TokenUsageMetrics };
