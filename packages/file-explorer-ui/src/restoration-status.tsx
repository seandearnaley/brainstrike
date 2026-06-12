/**
 * RestorationStatus - Floating progress indicator for restoring expanded directories
 *
 * Shows progress when the app is restoring previously expanded directories
 * from persisted state on startup.
 *
 * Rendered as an absolutely-positioned overlay card above the file tree (see
 * FileExplorerPanel) rather than an in-flow banner: mounting/unmounting must
 * never shift the tree. The card's internal structure is fixed-height for the
 * same reason — the path line is always reserved and counts use tabular-nums,
 * so per-tick progress updates cannot change the card's size.
 */

import { cn, Progress } from '@brainstrike/ui';
import { FolderOpen, Loader2 } from 'lucide-react';
import * as React from 'react';
import { useMemo } from 'react';

import type { RestorationProgress } from './shell/use-file-explorer-context';
import { formatTrailingPathSegments } from './utils/path-display';

export interface RestorationStatusProps {
  /** Additional CSS classes */
  className?: string | undefined;
  /** Whether restoration is in progress */
  isRestoring: boolean;
  /** Restoration progress information */
  progress: RestorationProgress | null;
}

export const RestorationStatus: React.FC<RestorationStatusProps> = React.memo(
  ({ isRestoring, progress, className }) => {
    const percentage = useMemo(() => {
      if (!progress || progress.total === 0) {
        return 0;
      }
      return Math.round((progress.loaded / progress.total) * 100);
    }, [progress]);

    const statusText = useMemo(() => {
      if (!progress) {
        return 'Restoring folders...';
      }

      return `Restoring ${progress.loaded}/${progress.total} folders`;
    }, [progress]);

    const displayPath = useMemo(() => {
      if (!progress?.currentPath) {
        return null;
      }
      return formatTrailingPathSegments(progress.currentPath);
    }, [progress]);

    if (!isRestoring) {
      return null;
    }

    return (
      <div
        aria-live="polite"
        className={cn(
          'flex items-center gap-3 rounded-lg border bg-background/90 px-3 py-2 shadow-md backdrop-blur-sm',
          // Enter animation via @starting-style: fades/slides in on mount
          // without affecting layout (the card is an overlay).
          'starting:-translate-y-2 starting:opacity-0 transition-all duration-300 ease-out',
          'motion-reduce:transition-none',
          className
        )}
        data-testid="restoration-status"
        role="status"
      >
        {/* Icon with animation */}
        <div className="relative shrink-0">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <Loader2 className="absolute -right-1 -bottom-1 h-3 w-3 animate-spin text-primary" />
        </div>

        {/* Progress bar and text. Every line is always rendered (the path line
            reserves its height when empty) so progress ticks never resize the card. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium text-foreground text-sm tabular-nums">
              {statusText}
            </span>
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {percentage}%
            </span>
          </div>
          <Progress aria-label="Folder restoration progress" className="h-1" value={percentage} />
          <span
            className="min-h-4 truncate text-muted-foreground text-xs"
            {...(progress?.currentPath ? { title: progress.currentPath } : {})}
          >
            {displayPath}
          </span>
        </div>
      </div>
    );
  }
);

RestorationStatus.displayName = 'RestorationStatus';
