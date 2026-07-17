import { calculateProgressPercentage } from '@brainstrike/file-explorer-hooks';
import type { DepthProgress } from '@brainstrike/types';
import { Button, cn, Progress } from '@brainstrike/ui';
import { Loader2, RefreshCw, X } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useReducer } from 'react';
import {
  useCancelButtonDelay,
  useKeyboardCancellation,
  useProgressDescription,
  useProgressMessage,
} from './hooks';

type EtaAction = { type: 'reset' } | { type: 'tick'; now: number; isStart: boolean };
interface EtaState {
  nowMs: number | null;
  startMs: number | null;
}

const etaReducer = (state: EtaState, action: EtaAction): EtaState => {
  if (action.type === 'reset') {
    return { nowMs: null, startMs: null };
  }
  return {
    nowMs: action.now,
    startMs: action.isStart ? action.now : (state.startMs ?? action.now),
  };
};

export interface LoadingProgressState {
  currentPath?: string;
  /** Depth-based progress for streaming updates */
  depthProgress?: DepthProgress;
  loaded: number;
  /** Monotonically increasing percentage (0-100), never decreases */
  percentage?: number;
  phase: 'counting' | 'loading';
  total: number;
}

export interface LoadingOverlayProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Whether the loading operation can be cancelled */
  cancellable?: boolean;
  description?: string;
  /** Whether the operation is currently being cancelled */
  isCancelling?: boolean;
  isInitialLoad?: boolean;
  isLoading: boolean;
  message?: string;
  /** Callback function to handle cancellation */
  onCancel?: () => void;
  progressLoaded?: number;
  progressState?: LoadingProgressState;
  progressTotal?: number;
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

  // Track start time and current time for ETA using useReducer for single-dispatch updates.
  const [etaTimes, dispatchEta] = useReducer(etaReducer, { nowMs: null, startMs: null });
  const isLoadingPhase = progressState?.phase === 'loading';
  const hasJustStarted = progressState?.loaded === 0;

  useEffect(() => {
    if (isCancelling || !progressState) {
      dispatchEta({ type: 'reset' });
      return;
    }
    if (isLoadingPhase) {
      dispatchEta({ isStart: hasJustStarted, now: performance.now(), type: 'tick' });
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

    // Use pre-calculated percentage if available (from streaming progress)
    if (progressState?.percentage !== undefined) {
      return progressState.percentage;
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
    if (progressState?.phase !== 'loading') {
      return null;
    }
    const { loaded, total } = progressState;
    const { startMs } = etaTimes;
    if (!startMs || total === 0 || loaded < 10) {
      return null;
    }
    // Use performance.now() inline for fresh elapsed time on each render
    const elapsedSec = (performance.now() - startMs) / 1000;
    const rate = loaded / Math.max(elapsedSec, 0.001);
    if (rate <= 0) {
      return null;
    }
    const remaining = Math.max(total - loaded, 0);
    const seconds = Math.round(remaining / rate);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `~${mins > 0 ? `${mins}m ` : ''}${secs}s remaining`;
  }, [progressState, etaTimes]);

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
            <Loader2 aria-hidden="true" className="h-10 w-10 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="h-10 w-10 animate-spin" />
          )}
        </div>
        <div className="w-full">
          <Progress
            aria-label="Loading progress"
            className={cn('h-2', isCancelling && 'opacity-50')}
            data-progress={isCancelling ? 0 : progressPercentage}
            data-testid="progress-bar"
            value={isCancelling ? 0 : progressPercentage}
          />
        </div>
        <div className="w-[min(92vw,24rem)] max-w-prose">
          {(() => {
            const lines = String(progressMessage).split('\n');
            const [depthLine, statsLine, pathLine] = lines;
            return (
              <>
                {/* Primary: Depth scanning status */}
                <p aria-live="polite" className="font-medium leading-relaxed">
                  {depthLine}
                </p>
                {/* Secondary: Stats (files/directories count) */}
                {statsLine && (
                  <p aria-live="polite" className="mt-0.5 text-muted-foreground text-sm">
                    {statsLine}
                  </p>
                )}
                {/* Tertiary: Current path being processed */}
                {pathLine && (
                  <p
                    aria-live="polite"
                    className="mt-0.5 truncate text-muted-foreground/70 text-xs"
                    title={pathLine}
                  >
                    {pathLine}
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
