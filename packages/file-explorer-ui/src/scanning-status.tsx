/**
 * ScanningStatus - Inline progress indicator for file tree scanning
 *
 * Shows depth-based progress without blocking the tree view,
 * allowing users to see files streaming in as they're discovered.
 */

import type { DepthProgress } from '@brainstrike/types';
import { Button, cn, Progress } from '@brainstrike/ui';
import { Loader2, X } from 'lucide-react';
import * as React from 'react';
import { useMemo } from 'react';

export interface ScanningStatusProps {
  /** Whether the operation can be cancelled */
  cancellable?: boolean | undefined;
  /** Additional CSS classes */
  className?: string | undefined;
  /** Current path being scanned */
  currentPath?: string | undefined;
  /** Depth-based progress information */
  depthProgress?: DepthProgress | undefined;
  /** Whether cancellation is in progress */
  isCancelling?: boolean | undefined;
  /** Whether scanning is in progress */
  isScanning: boolean;
  /** Callback to cancel the operation */
  onCancel?: (() => void) | undefined;
  /** Progress percentage (0-100) */
  percentage?: number | undefined;
}

/**
 * Format path for display by showing only the last 2 parts
 */
const formatDisplayPath = (currentPath: string): string => {
  const parts = currentPath.split('/');
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : currentPath;
};

export const ScanningStatus: React.FC<ScanningStatusProps> = React.memo(
  ({
    isScanning,
    depthProgress,
    currentPath,
    percentage = 0,
    cancellable = false,
    isCancelling = false,
    onCancel,
    className,
  }) => {
    const statusText = useMemo(() => {
      if (isCancelling) {
        return 'Cancelling...';
      }

      if (!depthProgress) {
        return 'Scanning...';
      }

      const { currentDepth, maxDepthSeen, estimatedMaxDepth, filesFound, directoriesCompleted } =
        depthProgress;

      // Depth label
      let depthLabel: string;
      if (maxDepthSeen >= 2) {
        depthLabel = `Depth ${currentDepth}/${estimatedMaxDepth}`;
      } else {
        depthLabel = `Depth ${currentDepth}`;
      }

      // Stats
      const stats = `${filesFound.toLocaleString()} files, ${directoriesCompleted} dirs`;

      return `${depthLabel} · ${stats}`;
    }, [depthProgress, isCancelling]);

    const displayPath = useMemo(() => {
      if (!currentPath) {
        return null;
      }
      return formatDisplayPath(currentPath);
    }, [currentPath]);

    if (!isScanning) {
      return null;
    }

    return (
      <div
        className={cn(
          'flex items-center gap-3 border-b bg-muted/30 px-4 py-2',
          isCancelling && 'opacity-60',
          className
        )}
        data-testid="scanning-status"
      >
        {/* Spinner */}
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />

        {/* Progress bar and text */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm">{statusText}</span>
            {percentage > 0 && (
              <span className="shrink-0 text-muted-foreground text-xs">{percentage}%</span>
            )}
          </div>
          <Progress
            aria-label="File scanning progress"
            className="h-1"
            value={isCancelling ? 0 : percentage}
          />
          {displayPath && (
            <span className="truncate text-muted-foreground text-xs" title={currentPath}>
              {displayPath}
            </span>
          )}
        </div>

        {/* Cancel button */}
        {cancellable && (
          <Button
            aria-label={isCancelling ? 'Cancelling' : 'Cancel scanning'}
            className="h-6 w-6 shrink-0"
            disabled={isCancelling}
            onClick={onCancel}
            size="icon"
            variant="ghost"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    );
  }
);

ScanningStatus.displayName = 'ScanningStatus';
