import { useWatcherHealth } from '@brainstrike/file-explorer-hooks';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@brainstrike/ui';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';

export interface WatcherHealthChipProps {
  /** Absolute root path this chip reports on (matches the watch handle path). */
  rootPath: string;
}

/**
 * Per-root watcher health indicator (BST-568 slice 3).
 *
 * Renders NOTHING while the watcher is healthy/starting/stopped or on
 * platforms without the health capability — the chip is an exception
 * surface, not a status ornament. `degraded` shows an amber warning (the
 * subscription is alive; the root was re-scanned); `failed` shows a red
 * warning plus a deliberate retry action (main-process throttling applies).
 */
export const WatcherHealthChip = ({ rootPath }: WatcherHealthChipProps) => {
  const { healthByRoot, retry } = useWatcherHealth();
  const [retryPending, setRetryPending] = useState(false);
  const health = healthByRoot.get(rootPath);

  const onRetry = useCallback(async () => {
    setRetryPending(true);
    try {
      await retry(rootPath);
    } finally {
      setRetryPending(false);
    }
  }, [retry, rootPath]);

  if (!health || (health.state !== 'degraded' && health.state !== 'failed')) {
    return null;
  }

  const isFailed = health.state === 'failed';
  const label = isFailed ? 'File watching failed' : 'File watching degraded';
  const detail = health.failure ? `${label}: ${health.failure.message}` : label;

  return (
    <TooltipProvider>
      <span
        className="flex items-center gap-1"
        data-state={health.state}
        data-testid="watcher-health-chip"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertTriangle
              aria-label={label}
              className={`h-3.5 w-3.5 ${isFailed ? 'text-destructive' : 'text-amber-500'}`}
              role="img"
            />
          </TooltipTrigger>
          <TooltipContent>{detail}</TooltipContent>
        </Tooltip>
        {isFailed ? (
          <button
            aria-label="Retry file watching"
            className="rounded p-0.5 hover:bg-muted disabled:opacity-50"
            disabled={retryPending}
            onClick={onRetry}
            type="button"
          >
            <RefreshCw className={`h-3 w-3 ${retryPending ? 'animate-spin' : ''}`} />
          </button>
        ) : null}
      </span>
    </TooltipProvider>
  );
};
