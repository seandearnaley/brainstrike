import { FileExplorerStrings } from '@brainstrike/types';
import { Button, Progress, cn } from '@brainstrike/ui';
import { Database, Loader2, RefreshCw, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { calculateProgressPercentage } from './use-file-tree-context';

export interface DatabaseProgressState {
  loaded: number;
  total: number;
  isLoading: boolean;
}

export interface LoadingProgressState {
  loaded: number;
  total: number;
  currentPath?: string;
  phase: 'counting' | 'loading';
}

export interface DatabaseLoadingOverlayProps extends React.HTMLAttributes<HTMLDivElement> {
  /** File tree loading state */
  isFileTreeLoading: boolean;
  isInitialLoad?: boolean;
  fileTreeProgressState?: LoadingProgressState;

  /** Database population state */
  isDatabasePopulating: boolean;
  databaseProgressState?: DatabaseProgressState | undefined;

  /** Override messages */
  message?: string;
  description?: string;

  /** Cancellation support */
  cancellable?: boolean;
  onCancel?: () => void;
  isCancelling?: boolean;
}

// Custom hook for delay logic
const useCancelButtonDelay = (isLoading: boolean, cancellable: boolean, isCancelling: boolean) => {
  const [showCancelButton, setShowCancelButton] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

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

  return showCancelButton;
};

// Custom hook for keyboard handling
const useKeyboardCancellation = (
  isLoading: boolean,
  cancellable: boolean,
  isCancelling: boolean,
  onCancel?: () => void
) => {
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
};

// Custom hook for combined loading state
const useCombinedLoadingState = (
  isFileTreeLoading: boolean,
  isDatabasePopulating: boolean,
  fileTreeProgressState?: LoadingProgressState,
  _databaseProgressState?: DatabaseProgressState
) => {
  return useMemo(() => {
    const isLoading = isFileTreeLoading || isDatabasePopulating;

    // Determine primary operation and phase
    let primaryPhase: 'counting' | 'loading' | 'database-population' | null = null;
    let secondaryPhase: 'counting' | 'loading' | 'database-population' | null = null;

    if (isDatabasePopulating) {
      primaryPhase = 'database-population';
      if (isFileTreeLoading) {
        secondaryPhase = fileTreeProgressState?.phase || 'loading';
      }
    } else if (isFileTreeLoading) {
      primaryPhase = fileTreeProgressState?.phase || 'loading';
    }

    return {
      isLoading,
      primaryPhase,
      secondaryPhase,
      showDualProgress: isDatabasePopulating && isFileTreeLoading,
    };
  }, [isFileTreeLoading, isDatabasePopulating, fileTreeProgressState]);
};

// Custom hook for message generation
const useProgressMessage = (
  isCancelling: boolean,
  message: string | undefined,
  isInitialLoad: boolean | undefined,
  primaryPhase: string | null,
  secondaryPhase: string | null,
  fileTreeProgressState?: LoadingProgressState,
  databaseProgressState?: DatabaseProgressState
) => {
  return useMemo(() => {
    if (isCancelling) {
      return 'Cancelling operation...';
    }

    if (message) return message;

    if (primaryPhase === 'database-population' && databaseProgressState) {
      const { loaded, total } = databaseProgressState;
      const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;

      if (secondaryPhase) {
        return `Loading folder into database (${loaded}/${total} - ${percent}%)\nScanning file tree...`;
      }

      return `Loading folder into database (${loaded}/${total} - ${percent}%)`;
    }

    if (primaryPhase === 'counting') {
      return secondaryPhase
        ? 'Scanning directory structure...\nPreparing database...'
        : 'Scanning directory structure...';
    }

    if (primaryPhase === 'loading' && fileTreeProgressState) {
      const { loaded, total, currentPath } = fileTreeProgressState;

      if (total === 0) return 'Preparing...';

      const percent = Math.round((loaded / total) * 100);
      const baseMsg = `Processing files (${loaded}/${total} - ${percent}%)`;

      if (currentPath) {
        const parts = currentPath.split('/');
        const displayPath = parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : currentPath;
        return secondaryPhase
          ? `${baseMsg}\n${displayPath}\nLoading into database...`
          : `${baseMsg}\n${displayPath}`;
      }

      return secondaryPhase ? `${baseMsg}\nLoading into database...` : baseMsg;
    }

    if (isInitialLoad) {
      return FileExplorerStrings.loading.rootDirectory;
    }

    return FileExplorerStrings.loading.refreshing;
  }, [
    isCancelling,
    message,
    isInitialLoad,
    primaryPhase,
    secondaryPhase,
    fileTreeProgressState,
    databaseProgressState,
  ]);
};

// Custom hook for description generation
const useProgressDescription = (
  isCancelling: boolean,
  description: string | undefined,
  primaryPhase: string | null,
  showDualProgress: boolean
) => {
  return useMemo(() => {
    if (isCancelling) {
      return 'Please wait while the operation is safely cancelled...';
    }

    if (description) return description;

    if (showDualProgress) {
      return 'Loading file tree and populating database - this may take a moment for large directories';
    }

    if (primaryPhase === 'database-population') {
      return 'Storing files in local database for faster access';
    }

    if (primaryPhase === 'counting') {
      return 'This may take a moment for large directories';
    }

    return FileExplorerStrings.prompts.waitForLoading;
  }, [isCancelling, description, primaryPhase, showDualProgress]);
};

export const DatabaseLoadingOverlay = React.forwardRef<HTMLDivElement, DatabaseLoadingOverlayProps>(
  (
    {
      className,
      isFileTreeLoading,
      isInitialLoad = false,
      fileTreeProgressState,
      isDatabasePopulating,
      databaseProgressState,
      message,
      description,
      cancellable = false,
      onCancel,
      isCancelling = false,
      ...props
    },
    ref
  ) => {
    const { isLoading, primaryPhase, secondaryPhase, showDualProgress } = useCombinedLoadingState(
      isFileTreeLoading,
      isDatabasePopulating,
      fileTreeProgressState,
      databaseProgressState
    );

    const showCancelButton = useCancelButtonDelay(isLoading, cancellable, isCancelling);
    useKeyboardCancellation(isLoading, cancellable, isCancelling, onCancel);

    const progressMessage = useProgressMessage(
      isCancelling,
      message,
      isInitialLoad,
      primaryPhase,
      secondaryPhase,
      fileTreeProgressState,
      databaseProgressState
    );

    const progressDescription = useProgressDescription(
      isCancelling,
      description,
      primaryPhase,
      showDualProgress
    );

    const handleCancel = useCallback(() => {
      if (onCancel && !isCancelling) {
        onCancel();
      }
    }, [onCancel, isCancelling]);

    // Calculate primary progress percentage
    const primaryProgressPercentage = useMemo(() => {
      if (primaryPhase === 'counting') return 0;

      if (primaryPhase === 'database-population' && databaseProgressState) {
        return calculateProgressPercentage(
          databaseProgressState.loaded,
          databaseProgressState.total
        );
      }

      if (primaryPhase === 'loading' && fileTreeProgressState) {
        return calculateProgressPercentage(
          fileTreeProgressState.loaded,
          fileTreeProgressState.total
        );
      }

      return 0;
    }, [primaryPhase, databaseProgressState, fileTreeProgressState]);

    // Calculate secondary progress percentage for dual progress display
    const secondaryProgressPercentage = useMemo(() => {
      if (!showDualProgress) return 0;

      if (secondaryPhase === 'counting') return 0;

      if (secondaryPhase === 'loading' && fileTreeProgressState) {
        return calculateProgressPercentage(
          fileTreeProgressState.loaded,
          fileTreeProgressState.total
        );
      }

      return 0;
    }, [showDualProgress, secondaryPhase, fileTreeProgressState]);

    if (!isLoading) return null;

    const IconComponent =
      primaryPhase === 'database-population' ? Database : isInitialLoad ? Loader2 : RefreshCw;

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
            <IconComponent
              className={cn(
                'h-10 w-10',
                primaryPhase === 'database-population'
                  ? 'animate-pulse text-blue-500'
                  : 'animate-spin'
              )}
            />
          </div>

          <div className="w-64 space-y-2">
            {/* Primary progress bar */}
            <div className="space-y-1">
              {showDualProgress && (
                <div className="text-xs text-muted-foreground text-left">
                  {primaryPhase === 'database-population'
                    ? 'Database Population'
                    : 'File Tree Loading'}
                </div>
              )}
              <Progress
                value={isCancelling ? 0 : primaryProgressPercentage}
                data-testid="primary-progress-bar"
                data-progress={isCancelling ? 0 : primaryProgressPercentage}
                className={cn(
                  isCancelling && 'opacity-50',
                  primaryPhase === 'database-population' && 'bg-blue-100'
                )}
              />
            </div>

            {/* Secondary progress bar (only shown during dual operations) */}
            {showDualProgress && (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground text-left">File Tree Loading</div>
                <Progress
                  value={isCancelling ? 0 : secondaryProgressPercentage}
                  data-testid="secondary-progress-bar"
                  data-progress={isCancelling ? 0 : secondaryProgressPercentage}
                  className={cn(isCancelling && 'opacity-50', 'bg-gray-100')}
                />
              </div>
            )}
          </div>

          <div>
            <p className="whitespace-pre-line font-medium">{progressMessage}</p>
            <p className="mt-1 text-sm opacity-75">{progressDescription}</p>
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

DatabaseLoadingOverlay.displayName = 'DatabaseLoadingOverlay';
