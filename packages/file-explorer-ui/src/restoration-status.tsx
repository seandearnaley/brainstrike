/**
 * RestorationStatus - Inline progress indicator for restoring expanded directories
 *
 * Shows progress when the app is restoring previously expanded directories
 * from persisted state on startup.
 */

import { cn, Progress } from '@brainstrike/ui';
import { FolderOpen, Loader2 } from 'lucide-react';
import * as React from 'react';
import { useMemo } from 'react';

import type { RestorationProgress } from './use-file-explorer-context';
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
        className={cn(
          'flex items-center gap-3 border-b bg-amber-50/50 px-4 py-2 dark:bg-amber-950/20',
          className
        )}
        data-testid="restoration-status"
      >
        {/* Icon with animation */}
        <div className="relative shrink-0">
          <FolderOpen className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <Loader2 className="absolute -right-1 -bottom-1 h-3 w-3 animate-spin text-amber-600 dark:text-amber-400" />
        </div>

        {/* Progress bar and text */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-amber-800 text-sm dark:text-amber-200">
              {statusText}
            </span>
            <span className="shrink-0 text-amber-600 text-xs dark:text-amber-400">
              {percentage}%
            </span>
          </div>
          <Progress
            className="h-1 bg-amber-200 dark:bg-amber-800 [&>div]:bg-amber-500"
            value={percentage}
          />
          {displayPath && (
            <span
              className="truncate text-amber-600 text-xs dark:text-amber-400"
              title={progress?.currentPath ?? undefined}
            >
              {displayPath}
            </span>
          )}
        </div>
      </div>
    );
  }
);

RestorationStatus.displayName = 'RestorationStatus';
