import { calculateProgressPercentage } from '@brainstrike/file-explorer-hooks';
import { Button, cn, Progress } from '@brainstrike/ui';
import { Loader2, RefreshCw, X } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useCancelButtonDelay,
  useKeyboardCancellation,
  useProgressDescription,
  useProgressMessage,
} from './hooks';

export type LoadingProgressState = {
  loaded: number;
  total: number;
  currentPath?: string;
  phase: 'counting' | 'loading';
};

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

export const LoadingOverlay = ({
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
  ref,
  ...props
}: LoadingOverlayProps & { ref?: React.RefObject<HTMLDivElement | null> }) => {
  const showCancelButton = useCancelButtonDelay(isLoading, cancellable, isCancelling);
  useKeyboardCancellation(isLoading, cancellable, isCancelling, onCancel);

  const progressMessage = useProgressMessage(isCancelling, message, isInitialLoad, progressState);
  const progressDescription = useProgressDescription(isCancelling, description, progressState);

  // Track start time to estimate remaining time. Reset when a new load begins.
  const startTimeRef = useRef<number | null>(null);
  const isLoadingPhase = progressState?.phase === 'loading';
  const hasJustStarted = progressState?.loaded === 0;

  useEffect(() => {
    if (isCancelling) {
      return;
    }
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
    if (progressState?.phase === 'counting') {
      return 0;
    }

    if (progressState) {
      return calculateProgressPercentage(progressState.loaded, progressState.total);
    }

    if (progressTotal > 0) {
      return calculateProgressPercentage(progressLoaded, progressTotal);
    }

    return 0;
  }, [progressState, progressLoaded, progressTotal]);

  const etaText = useMemo(() => {
    if (!progressState || progressState.phase !== 'loading') {
      return null;
    }
    const { loaded, total } = progressState;
    if (!startTimeRef.current || total === 0 || loaded < 10) {
      return null;
    }
    const elapsedSec = (performance.now() - startTimeRef.current) / 1000;
    const rate = loaded / Math.max(elapsedSec, 0.001);
    if (rate <= 0) {
      return null;
    }
    const remaining = Math.max(total - loaded, 0);
    const seconds = Math.round(remaining / rate);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `~${mins > 0 ? `${mins}m ` : ''}${secs}s remaining`;
  }, [progressState]);

  if (!isLoading) {
    return null;
  }

  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cn(
        // Dimmed, blurred backdrop
        'fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm',
        className
      )}
      ref={ref}
      role="alert"
      {...props}
    >
      {/* Glassmorphic card container */}
      <div
        className={cn(
          'flex w-[min(92vw,28rem)] flex-col items-center space-y-4 rounded-xl text-center',
          'border border-white/10 bg-white/5 shadow-black/20 shadow-lg',
          'p-6 backdrop-blur-md'
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
            className={cn('h-2', isCancelling && 'opacity-50')}
            data-progress={isCancelling ? 0 : progressPercentage}
            data-testid="progress-bar"
            value={isCancelling ? 0 : progressPercentage}
          />
        </div>
        <div className="w-[min(92vw,24rem)] max-w-prose">
          {(() => {
            const [line1, line2] = String(progressMessage).split('\n');
            return (
              <>
                <p aria-live="polite" className="font-medium leading-relaxed">
                  {line1}
                </p>
                {line2 && (
                  <p
                    aria-live="polite"
                    className="mt-0.5 truncate text-muted-foreground/90 text-xs"
                    title={line2}
                  >
                    {line2}
                  </p>
                )}
              </>
            );
          })()}
          <p aria-live="polite" className="mt-1 text-muted-foreground/90 text-sm">
            {etaText ?? progressDescription}
          </p>
        </div>
        {cancellable && (showCancelButton || isCancelling) && (
          <div className="mt-4 flex flex-col items-center">
            <Button
              aria-label={isCancelling ? 'Cancelling operation' : 'Cancel operation'}
              className="flex items-center gap-2"
              disabled={isCancelling}
              onClick={handleCancel}
              size="sm"
              variant="destructive"
            >
              <X className="h-4 w-4" />
              {isCancelling ? 'Cancelling...' : 'Cancel'}
            </Button>
            {!isCancelling && (
              <p className="mt-2 text-muted-foreground text-xs">Press Escape to cancel</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

LoadingOverlay.displayName = 'LoadingOverlay';
