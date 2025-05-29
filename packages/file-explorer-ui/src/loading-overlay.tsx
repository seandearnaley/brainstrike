import { FileExplorerStrings } from '@brainstrike/types';
import { Progress } from '@brainstrike/ui';
import { cn } from '@brainstrike/ui';
import { Loader2, RefreshCw } from 'lucide-react';
import React from 'react';
import { calculateProgressPercentage } from './use-file-tree-context';

export interface LoadingProgressState {
  loaded: number;
  total: number;
  currentPath?: string;
  phase: 'counting' | 'loading';
}

export interface LoadingOverlayProps extends React.HTMLAttributes<HTMLDivElement> {
  isLoading: boolean;
  isInitialLoad?: boolean;
  progressLoaded?: number;
  progressTotal?: number;
  progressState?: LoadingProgressState;
  message?: string;
  description?: string;
  onCancel?: () => void;
  isCancellable?: boolean;
  isCancelling?: boolean;
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
      onCancel,
      isCancellable = false,
      isCancelling = false,
      ...props
    },
    ref
  ) => {
    if (!isLoading) return null;

    const getProgressMessage = () => {
      if (message) return message;

      if (isInitialLoad) {
        return FileExplorerStrings.loading.rootDirectory;
      }

      if (!progressState) {
        return isInitialLoad
          ? FileExplorerStrings.loading.rootDirectory
          : FileExplorerStrings.loading.refreshing;
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
        return FileExplorerStrings.prompts.waitForLoading;
      }
      if (progressState.phase === 'counting') {
        return 'This may take a moment for large directories';
      }
      return FileExplorerStrings.prompts.waitForLoading;
    };

    const progressPercentage =
      progressState?.phase === 'counting'
        ? 0
        : progressState
          ? calculateProgressPercentage(progressState.loaded, progressState.total)
          : progressTotal > 0
            ? calculateProgressPercentage(progressLoaded, progressTotal)
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
            {isCancelling && (
              <p className="mt-2 text-sm text-yellow-600 dark:text-yellow-500">Cancelling, please wait...</p>
            )}
          </div>
          {isCancellable && !isCancelling && onCancel && (
            <div className="mt-4">
              <button
                onClick={onCancel}
                className="px-4 py-2 text-sm font-medium text-primary rounded-md bg-background hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                aria-label="Cancel loading process"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
);

LoadingOverlay.displayName = 'LoadingOverlay';
