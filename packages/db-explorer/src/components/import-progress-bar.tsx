import { Button, Progress } from '@brainstrike/ui';
import { CheckCircle, FileText, Layers, X } from 'lucide-react';
import type { EnhancedImportProgress } from '../types';

interface ImportProgressBarProps {
  isCancelling?: boolean;
  onCancel?: () => void;
  onClose?: () => void;
  progress: EnhancedImportProgress;
}

/**
 * ImportProgressBar - Compact inline progress display for import operations.
 *
 * Designed to sit above the footer toolbar with minimal height.
 * Shows dual progress bars for files and chunks side by side.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Progress rendering branches on multiple phases.
export function ImportProgressBar({
  progress,
  onClose,
  onCancel,
  isCancelling,
}: ImportProgressBarProps) {
  const { total, completed, errors } = progress;
  const filePercentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const isComplete = total > 0 && completed >= total;
  const hasErrors = errors.length > 0;
  const showCancelButton = onCancel && !isComplete && !isCancelling;

  // Chunk progress from chunkingProgress or queueProgress
  const chunkProgress = progress.chunkingProgress ?? progress.queueProgress;
  const chunkTotal = chunkProgress
    ? 'totalFiles' in chunkProgress
      ? chunkProgress.totalFiles
      : chunkProgress.totalQueued
    : 0;
  const chunkCompleted = chunkProgress
    ? 'filesProcessed' in chunkProgress
      ? chunkProgress.filesProcessed
      : chunkProgress.processed + chunkProgress.failed
    : 0;
  const chunkPercentage = chunkTotal > 0 ? Math.round((chunkCompleted / chunkTotal) * 100) : 0;

  return (
    <div className="flex items-center gap-4 border-t bg-muted/30 px-4 py-2">
      {/* Status indicator */}
      <div className="flex items-center gap-2">
        {isComplete ? (
          <CheckCircle aria-hidden="true" className="h-4 w-4 text-emerald-500" />
        ) : isCancelling ? (
          <div aria-hidden="true" className="h-4 w-4 animate-pulse rounded-full bg-amber-500/50" />
        ) : (
          <div
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent"
          />
        )}
        <span className="whitespace-nowrap font-medium text-xs">
          {isComplete ? 'Complete' : isCancelling ? 'Cancelling...' : 'Importing'}
        </span>
      </div>

      {/* Progress bars container */}
      <div className="flex min-w-0 flex-1 items-center gap-6">
        {/* Files progress */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <FileText aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="whitespace-nowrap font-medium text-[11px]">Files</span>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Progress
              aria-label="Files import progress"
              className="h-1.5 flex-1"
              value={filePercentage}
            />
            <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground tabular-nums">
              {completed}/{total}
            </span>
          </div>
        </div>

        {/* Chunks progress */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Layers aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="whitespace-nowrap font-medium text-[11px]">Chunks</span>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Progress
              aria-label="Chunks import progress"
              className="h-1.5 flex-1"
              value={chunkPercentage}
            />
            <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground tabular-nums">
              {chunkCompleted}/{chunkTotal}
            </span>
          </div>
        </div>
      </div>

      {/* Error indicator */}
      {hasErrors && (
        <span className="whitespace-nowrap rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-[10px] text-destructive">
          {errors.length} error{errors.length === 1 ? '' : 's'}
        </span>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-1">
        {showCancelButton && (
          <Button
            aria-label="Cancel import"
            className="h-6 gap-1 px-2 font-medium text-[11px]"
            onClick={onCancel}
            size="sm"
            variant="destructive"
          >
            Cancel
          </Button>
        )}
        {onClose && isComplete && (
          <Button
            aria-label="Close import progress"
            className="h-6 w-6 shrink-0 p-0"
            onClick={onClose}
            size="sm"
            variant="ghost"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
