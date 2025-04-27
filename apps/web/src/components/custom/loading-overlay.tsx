import { Progress } from '@brainstrike/ui';
import { cn } from '@brainstrike/ui';
import { Loader2, RefreshCw } from 'lucide-react';
import React from 'react';
import type { LoadingProgressState } from '../../hooks/use-file-tree';
import { FileExplorerStrings } from './constants/file-explorer-constants';

export interface LoadingOverlayProps extends React.HTMLAttributes<HTMLDivElement> {
  isLoading: boolean;
  isInitialLoad?: boolean;
  progressLoaded?: number;
  progressTotal?: number;
  progressState?: LoadingProgressState;
  message?: string;
  description?: string;
}

export const LoadingOverlay = React.forwardRef<HTMLDivElement, LoadingOverlayProps>(
  (
    {
      className,
      isLoading,
      isInitialLoad = false,
      progressLoaded = 0,
      progressTotal = 0,
      progressState,
      message,
      description,
      ...props
    },
    ref
  ) => {
    if (!isLoading) return null;

    const getProgressMessage = () => {
      if (message) return message;

      if (isInitialLoad) {
        return FileExplorerStrings.LOADING.ROOT_DIRECTORY;
      }

      if (!progressState) {
        return isInitialLoad
          ? FileExplorerStrings.LOADING.ROOT_DIRECTORY
          : FileExplorerStrings.LOADING.REFRESHING;
      }

      if (progressState.phase === 'counting') {
        return 'Scanning directory structure...';
      }

      const loaded = progressState.loaded;
      const total = progressState.total;
      const currentPath = progressState.currentPath;

      if (total === 0) return 'Preparing...';

      const percent = Math.round((loaded / total) * 100);
      const baseMsg = `Processing files (${loaded}/${total} - ${percent}%)`;

      if (currentPath) {
        // Get the last 2 parts of the path for display
        const parts = currentPath.split('/');
        const displayPath = parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : currentPath;
        return `${baseMsg}\n${displayPath}`;
      }

      return baseMsg;
    };

    const getProgressDescription = () => {
      if (description) return description;
      if (!progressState) {
        return FileExplorerStrings.PROMPTS.WAIT_FOR_LOADING;
      }
      if (progressState.phase === 'counting') {
        return 'This may take a moment for large directories';
      }
      return FileExplorerStrings.PROMPTS.WAIT_FOR_LOADING;
    };

    const progressPercentage =
      progressState?.phase === 'counting'
        ? 0
        : progressState
          ? Math.round((progressState.loaded / progressState.total) * 100) || 0
          : progressTotal > 0
            ? Math.round((progressLoaded / progressTotal) * 100)
            : 0;

    return (
      <div
        ref={ref}
        className={cn(
          'fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-xs',
          className
        )}
        role="alert"
        aria-busy="true"
        {...props}
      >
        <div className="flex flex-col items-center space-y-4 text-center">
          <div className="relative h-10 w-10">
            {isInitialLoad ? (
              <Loader2 className="h-10 w-10 animate-spin" />
            ) : (
              <RefreshCw className="h-10 w-10 animate-spin" />
            )}
          </div>
          <div className="w-64">
            <Progress
              value={progressPercentage}
              data-testid="progress-bar"
              data-progress={progressPercentage}
            />
          </div>
          <div>
            <p className="whitespace-pre-line font-medium">{getProgressMessage()}</p>
            <p className="mt-1 text-sm opacity-75">{getProgressDescription()}</p>
          </div>
        </div>
      </div>
    );
  }
);

LoadingOverlay.displayName = 'LoadingOverlay';
