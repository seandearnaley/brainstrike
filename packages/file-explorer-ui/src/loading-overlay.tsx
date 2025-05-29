import { FileExplorerStrings } from '@brainstrike/types';
import { Button, Progress, cn } from '@brainstrike/ui';
import { Loader2, RefreshCw, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
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
  /** Whether the loading operation can be cancelled */
  cancellable?: boolean;
  /** Callback function to handle cancellation */
  onCancel?: () => void;
  /** Whether the operation is currently being cancelled */
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
      cancellable = false,
      onCancel,
      isCancelling = false,
      ...props
    },
    ref
  ) => {
    const [showCancelButton, setShowCancelButton] = useState(false);

    // Show cancel button after 2 seconds to avoid accidental clicks on quick operations
    useEffect(() => {
      let timer: NodeJS.Timeout | undefined;

      if (isLoading && cancellable && !isCancelling) {
        timer = setTimeout(() => {
          setShowCancelButton(true);
        }, 2000);
      } else {
        setShowCancelButton(false);
      }

      return () => {
        if (timer) {
          clearTimeout(timer);
        }
      };
    }, [isLoading, cancellable, isCancelling]);

    // Handle keyboard shortcuts for cancellation
    useEffect(() => {
      if (!isLoading || !cancellable || isCancelling || !onCancel) {
        return;
      }
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      };

      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('keydown', handleKeyDown);
      };
    }, [isLoading, cancellable, onCancel, isCancelling]);

    const handleCancel = useCallback(() => {
      if (onCancel && !isCancelling) {
        onCancel();
      }
    }, [onCancel, isCancelling]);

    if (!isLoading) return null;

    const getProgressMessage = () => {
      if (isCancelling) {
        return 'Cancelling operation...';
      }

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
      if (isCancelling) {
        return 'Please wait while the operation is safely cancelled...';
      }

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
        aria-live="polite"
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
              value={isCancelling ? 0 : progressPercentage}
              data-testid="progress-bar"
              data-progress={isCancelling ? 0 : progressPercentage}
              className={cn(isCancelling && 'opacity-50')}
            />
          </div>
          <div>
            <p className="whitespace-pre-line font-medium">{getProgressMessage()}</p>
            <p className="mt-1 text-sm opacity-75">{getProgressDescription()}</p>
          </div>
          {cancellable && (showCancelButton || isCancelling) && (
            <div className="mt-4">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleCancel}
                disabled={isCancelling}
                className="flex items-center gap-2"
                aria-label={isCancelling ? 'Cancelling operation' : 'Cancel operation'}
              >
                <X className="h-4 w-4" />
                {isCancelling ? 'Cancelling...' : 'Cancel'}
              </Button>
              {!isCancelling && (
                <p className="mt-2 text-xs text-muted-foreground">Press Escape to cancel</p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
);

LoadingOverlay.displayName = 'LoadingOverlay';
