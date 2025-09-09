import { calculateProgressPercentage } from '@brainstrike/file-explorer-hooks';
import { Button, cn, Progress } from '@brainstrike/ui';
import { Loader2, RefreshCw, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useCancelButtonDelay,
  useKeyboardCancellation,
  useProgressDescription,
  useProgressMessage,
} from './hooks';

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
    const showCancelButton = useCancelButtonDelay(isLoading, cancellable, isCancelling);
    useKeyboardCancellation(isLoading, cancellable, isCancelling, onCancel);

    const progressMessage = useProgressMessage(isCancelling, message, isInitialLoad, progressState);
    const progressDescription = useProgressDescription(isCancelling, description, progressState);

    // Track start time to estimate remaining time. Reset when a new load begins.
    const startTimeRef = useRef<number | null>(null);
    const isLoadingPhase = progressState?.phase === 'loading';
    const hasJustStarted = progressState?.loaded === 0;

    useEffect(() => {
      if (isCancelling) return;
      if (!progressState) {
        startTimeRef.current = null;
        return;
      }
      if (isLoadingPhase && hasJustStarted) {
        startTimeRef.current = performance.now();
      }
    }, [isLoadingPhase, hasJustStarted, isCancelling, progressState]);

    const handleCancel = useCallback(() => {
      if (onCancel && !isCancelling) {
        onCancel();
      }
    }, [onCancel, isCancelling]);

    const progressPercentage = useMemo(() => {
      if (progressState?.phase === 'counting') return 0;

      if (progressState) {
        return calculateProgressPercentage(progressState.loaded, progressState.total);
      }

      if (progressTotal > 0) {
        return calculateProgressPercentage(progressLoaded, progressTotal);
      }

      return 0;
    }, [progressState, progressLoaded, progressTotal]);

    const etaText = useMemo(() => {
      if (!progressState || progressState.phase !== 'loading') return null;
      const { loaded, total } = progressState;
      if (!startTimeRef.current || total === 0 || loaded < 10) return null;
      const elapsedSec = (performance.now() - startTimeRef.current) / 1000;
      const rate = loaded / Math.max(elapsedSec, 0.001);
      if (rate <= 0) return null;
      const remaining = Math.max(total - loaded, 0);
      const seconds = Math.round(remaining / rate);
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `~${mins > 0 ? `${mins}m ` : ''}${secs}s remaining`;
    }, [progressState]);

    if (!isLoading) return null;

    return (
      <div
        ref={ref}
        className={cn(
          // Dimmed, blurred backdrop
          'fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm',
          className
        )}
        role="alert"
        aria-busy="true"
        aria-live="polite"
        {...props}
      >
        {/* Glassmorphic card container */}
        <div
          className={cn(
            'flex w-[min(92vw,28rem)] flex-col items-center space-y-4 text-center rounded-xl',
            'border border-white/10 bg-white/5 shadow-lg shadow-black/20',
            'backdrop-blur-md p-6'
          )}
        >
          <div className="relative h-10 w-10">
            {isInitialLoad ? (
              <Loader2 className="h-10 w-10 animate-spin" />
            ) : (
              <RefreshCw className="h-10 w-10 animate-spin" />
            )}
          </div>
          <div className="w-full">
            <Progress
              value={isCancelling ? 0 : progressPercentage}
              data-testid="progress-bar"
              data-progress={isCancelling ? 0 : progressPercentage}
              className={cn('h-2', isCancelling && 'opacity-50')}
            />
          </div>
          <div className="max-w-prose w-[min(92vw,24rem)]">
            {(() => {
              const [line1, line2] = String(progressMessage).split('\n');
              return (
                <>
                  <p className="font-medium leading-relaxed" aria-live="polite">
                    {line1}
                  </p>
                  {line2 && (
                    <p
                      className="mt-0.5 text-xs text-muted-foreground/90 truncate"
                      title={line2}
                      aria-live="polite"
                    >
                      {line2}
                    </p>
                  )}
                </>
              );
            })()}
            <p className="mt-1 text-sm text-muted-foreground/90" aria-live="polite">
              {etaText ?? progressDescription}
            </p>
          </div>
          {cancellable && (showCancelButton || isCancelling) && (
            <div className="mt-4 flex flex-col items-center">
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
