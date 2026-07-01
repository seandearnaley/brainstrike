import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { ChevronDown, Play, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import type { BackfillProgress } from './vector-status/use-vector-queue-state';

export interface EmbeddingActionsDropdownProps {
  /** Whether a backfill is in progress */
  backfilling: boolean;
  /** Progress of current backfill operation */
  backfillProgress: BackfillProgress;
  /** Additional className */
  className?: string;
  /** Coverage stats for tooltip */
  coverage: { total: number; withSet: number };
  /** Whether backfill is disabled */
  disabled?: boolean;
  /** Disabled reason tooltip */
  disabledReason?: string;
  /** Number of failed jobs in queue */
  failedCount: number;

  /** Whether an active embedding set is selected */
  hasActiveSet: boolean;
  /** Whether database is available */
  hasDb: boolean;
  /** Handler for backfill action */
  onBackfill: () => Promise<void>;
  /** Handler for clear queue (failed/queued items) */
  onClearQueue: () => Promise<void>;
  /** Handler for re-embedding the active collection */
  onReembed: () => Promise<void>;
  /** Handler for retry failed jobs */
  onRetryFailed: () => Promise<void>;
  /** Handler for wipe queue (all items) */
  onWipeQueue: () => Promise<void>;
  /** Queue counts for tooltip */
  queueCounts: { queued: number; running: number };
  /** Whether worker is starting */
  startingWorker?: boolean;
  /** Whether clicking will auto-start worker (web only) */
  willAutoStartWorker?: boolean;
}

function invokeAsyncAction(action: () => Promise<void>): void {
  // Action handlers own user-facing errors via toasts/status. Swallow the promise at
  // the click boundary so rejected async handlers do not surface as global
  // unhandledrejection events in the renderer.
  void action().catch(() => {});
}

/**
 * Determines button text based on current state
 */
function getBackfillButtonText(
  startingWorker: boolean,
  backfilling: boolean,
  backfillProgress: BackfillProgress,
  willAutoStartWorker: boolean
): string {
  if (backfilling) {
    if (backfillProgress) {
      return `${backfillProgress.done}/${backfillProgress.total}`;
    }
    return 'Backfilling…';
  }
  if (startingWorker) {
    return 'Starting…';
  }
  if (willAutoStartWorker) {
    return 'Start & Backfill';
  }
  return 'Backfill';
}

/**
 * EmbeddingActionsDropdown - Split button for embedding queue actions.
 *
 * Primary action: Backfill (creates embedding jobs for unprocessed chunks)
 * Secondary actions: Retry failed, Re-embed collection, Clear queue, Wipe queue
 *
 * The split button pattern keeps the most common action (Backfill) immediately
 * accessible while hiding destructive/less common actions in a dropdown.
 *
 * @example
 * ```tsx
 * <EmbeddingActionsDropdown
 *   onBackfill={handleBackfill}
 *   onRetryFailed={handleRetry}
 *   onClearQueue={handleClear}
 *   onWipeQueue={handleWipe}
 *   hasDb={true}
 *   backfilling={false}
 *   backfillProgress={null}
 *   failedCount={0}
 *   coverage={{ total: 100, withSet: 50 }}
 *   queueCounts={{ queued: 5, running: 2 }}
 * />
 * ```
 *
 * @see useEmbeddingControls - Hook that provides props for this component
 */
export function EmbeddingActionsDropdown({
  onBackfill,
  onReembed,
  onRetryFailed,
  onClearQueue,
  onWipeQueue,
  hasDb,
  backfilling,
  backfillProgress,
  failedCount,
  coverage,
  queueCounts,
  hasActiveSet,
  startingWorker = false,
  willAutoStartWorker = false,
  disabled = false,
  disabledReason,
  className,
}: EmbeddingActionsDropdownProps) {
  const isBackfillDisabled = disabled || !hasDb || backfilling || startingWorker;
  const isRetryDisabled = !hasDb || failedCount === 0;
  const isReembedDisabled =
    !(hasDb && hasActiveSet) ||
    backfilling ||
    startingWorker ||
    queueCounts.queued > 0 ||
    queueCounts.running > 0;
  const isClearDisabled = !hasDb;
  const isWipeDisabled = !hasDb;
  const retryLabel =
    failedCount > 0 && queueCounts.queued > 0 && queueCounts.running === 0
      ? 'Retry Failed & Stalled'
      : 'Retry Failed';

  const buttonText = getBackfillButtonText(
    startingWorker,
    backfilling,
    backfillProgress,
    willAutoStartWorker
  );

  // Determine tooltip for backfill button
  const getBackfillTooltip = (): string => {
    if (disabledReason) {
      return disabledReason;
    }
    if (!hasDb) {
      return 'Database not available';
    }
    if (backfilling) {
      return 'Backfill in progress…';
    }
    if (startingWorker) {
      return 'Starting embedding worker…';
    }
    if (coverage.withSet >= coverage.total && coverage.total > 0) {
      return 'All chunks already have embeddings';
    }
    if (queueCounts.queued > 0 || queueCounts.running > 0) {
      return 'Queue already has pending jobs';
    }
    if (willAutoStartWorker) {
      return 'Start worker and create embedding jobs for unprocessed chunks';
    }
    return 'Create embedding jobs for unprocessed chunks';
  };

  const backfillButton = (
    <Button
      aria-label={buttonText}
      className="h-8 rounded-r-none border-r-0 px-3 text-xs"
      disabled={isBackfillDisabled}
      onClick={() => invokeAsyncAction(onBackfill)}
      size="sm"
      variant="outline"
    >
      <Play className="mr-1.5 h-3 w-3" />
      {buttonText}
    </Button>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className={className}>
        <div className="flex">
          {/* Primary action - Backfill */}
          {isBackfillDisabled ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">{backfillButton}</span>
              </TooltipTrigger>
              <TooltipContent side="top">{getBackfillTooltip()}</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>{backfillButton}</TooltipTrigger>
              <TooltipContent side="top">{getBackfillTooltip()}</TooltipContent>
            </Tooltip>
          )}

          {/* Dropdown trigger */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="More embedding actions"
                className="h-8 rounded-l-none px-1.5"
                disabled={!hasDb}
                size="sm"
                variant="outline"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                disabled={isRetryDisabled}
                onClick={() => invokeAsyncAction(onRetryFailed)}
              >
                <RotateCcw className="mr-2 h-3.5 w-3.5" />
                <span>{retryLabel}</span>
                {failedCount > 0 && (
                  <span className="ml-auto text-muted-foreground text-xs">({failedCount})</span>
                )}
              </DropdownMenuItem>

              <DropdownMenuItem
                disabled={isReembedDisabled}
                onClick={() => invokeAsyncAction(onReembed)}
              >
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                <span>Re-embed Collection</span>
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                disabled={isClearDisabled}
                onClick={() => invokeAsyncAction(onClearQueue)}
              >
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                <span>Clear Queue</span>
              </DropdownMenuItem>

              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={isWipeDisabled}
                onClick={() => invokeAsyncAction(onWipeQueue)}
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                <span>Wipe All Jobs</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </TooltipProvider>
  );
}
