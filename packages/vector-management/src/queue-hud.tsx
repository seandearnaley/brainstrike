import { JobQueue, usePGliteDatabase } from '@brainstrike/db';
import { isAppActive } from '@brainstrike/hooks';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useToast,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { RotateCw } from 'lucide-react';
import {
  type Dispatch,
  type ReactElement,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

interface QueueStats {
  failed: number;
  nextRunnableAt?: string | null;
  queue: string;
  queued: number;
  running: number;
  succeeded: number;
}

type QueueHudVariant = 'card' | 'status-bar';

interface QueueHudProps {
  variant?: QueueHudVariant;
}

interface QueueMetrics {
  failed: number;
  nextRunnableAt?: string | null;
  queued: number;
  running: number;
  succeeded: number;
}

interface QueueHudViewProps {
  metrics: QueueMetrics;
  onRetry: () => Promise<void>;
  retryDisabled: boolean;
  retryLabel: string;
}

type ToastFn = ReturnType<typeof useToast>['toast'];

const logger = createLogger('QueueHud');

const EMBEDDING_QUEUE_NAME = 'embeddings';
// Retry up to 20 failed jobs at a time to avoid overwhelming the queue
// and provide better visibility into individual failures
const RETRY_BATCH_SIZE = 20;
// Poll every 2 seconds to balance UI responsiveness with database load
// Frequent enough to feel real-time without excessive queries
const QUEUE_POLL_INTERVAL_MS = 2000;

function isQueueEnabled(): boolean {
  try {
    // In browser contexts, treat the queue as enabled so HUD reflects runtime activity.
    if (typeof window !== 'undefined') {
      return true;
    }
    const env = typeof process !== 'undefined' ? process.env : undefined;
    const v = env?.['EMBED_QUEUE_ENABLED'];
    return String(v ?? 'false').toLowerCase() === 'true';
  } catch {
    return typeof window !== 'undefined';
  }
}

function getQueueMetrics(stats: QueueStats[] | null): QueueMetrics {
  const s = stats?.[0];
  // If no stats available, return zeros for all metrics
  if (!s) {
    return {
      queued: 0,
      running: 0,
      failed: 0,
      succeeded: 0,
      nextRunnableAt: null,
    };
  }
  // DB schema guarantees non-null values for count fields
  return {
    queued: s.queued,
    running: s.running,
    failed: s.failed,
    succeeded: s.succeeded,
    nextRunnableAt: s.nextRunnableAt ?? null,
  };
}

function getRetryLabel(failed: number): string {
  if (failed <= 0) {
    return 'Retry failed jobs';
  }

  return `Retry ${failed} failed job${failed === 1 ? '' : 's'}`;
}

function useQueueStats(
  jobQueue: JobQueue | null,
  shouldPoll: boolean
): [QueueStats[] | null, Dispatch<SetStateAction<QueueStats[] | null>>] {
  const [stats, setStats] = useState<QueueStats[] | null>(null);

  useEffect(() => {
    if (!jobQueue) {
      return;
    }

    let canceled = false;
    const fetchStats = async (): Promise<void> => {
      try {
        const s = await jobQueue.getQueueStats(EMBEDDING_QUEUE_NAME);
        if (!canceled) {
          setStats(s);
        }
      } catch (error) {
        // Log errors but don't break the UI
        logger.error('Failed to fetch queue stats', { error });
        // Keep existing stats to avoid UI flickering on transient errors
      }
    };

    void fetchStats();
    if (!shouldPoll) {
      return () => {
        canceled = true;
      };
    }

    const id = setInterval(() => {
      if (!isAppActive()) {
        return;
      }
      void fetchStats();
    }, QUEUE_POLL_INTERVAL_MS);
    return () => {
      canceled = true;
      clearInterval(id);
    };
  }, [jobQueue, shouldPoll]);

  return [stats, setStats];
}

function useQueueRetry(
  jobQueue: JobQueue | null,
  setStats: Dispatch<SetStateAction<QueueStats[] | null>>,
  toast: ToastFn
): { busy: boolean; handleRetry: () => Promise<void> } {
  const [busy, setBusy] = useState(false);

  const handleRetry = useCallback(async (): Promise<void> => {
    if (!jobQueue) {
      return;
    }
    try {
      setBusy(true);
      await jobQueue.requeueFailed(EMBEDDING_QUEUE_NAME, RETRY_BATCH_SIZE);
      const nextStats = await jobQueue.getQueueStats(EMBEDDING_QUEUE_NAME);
      setStats(nextStats);
      setBusy(false);
    } catch (error) {
      setBusy(false);
      logger.error('Failed to retry embedding queue jobs', { error });
      const message = error instanceof Error ? error.message : String(error);
      toast({
        title: 'Failed to retry jobs',
        description: message || 'Unable to retry failed embedding jobs.',
        variant: 'destructive',
      });
    }
  }, [jobQueue, setStats, toast]);

  return { busy, handleRetry };
}

function QueueHudStatusBar({
  metrics,
  retryDisabled,
  retryLabel,
  onRetry,
}: QueueHudViewProps): ReactElement {
  const { queued, running, failed, succeeded, nextRunnableAt } = metrics;

  return (
    <div className="flex items-center gap-2 text-[10px]" data-testid="status-bar-queue">
      <Tooltip>
        <TooltipTrigger asChild>
          {/* biome-ignore lint/a11y/useSemanticElements: Status text isn't a form calculation result. */}
          <div
            aria-label={`Embedding queue: ${queued} queued, ${running} running, ${failed} failed, ${succeeded} succeeded`}
            aria-live="polite"
            className="flex items-center gap-2 rounded px-1 py-0.5 text-[10px] text-muted-foreground"
            role="status"
          >
            <span className="font-medium text-foreground">Queue</span>
            <span className="flex items-center gap-1">
              <span>Q</span>
              <span className="font-semibold text-foreground">{queued}</span>
            </span>
            <span className="flex items-center gap-1">
              <span>R</span>
              <span className="font-semibold text-foreground">{running}</span>
            </span>
            <span className="flex items-center gap-1">
              <span>F</span>
              <span
                className={`font-semibold ${failed > 0 ? 'text-destructive' : 'text-foreground'}`}
              >
                {failed}
              </span>
            </span>
            <span className="flex items-center gap-1">
              <span>OK</span>
              <span className="font-semibold text-foreground">{succeeded}</span>
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          <div className="space-y-1 text-xs">
            <div className="font-medium">Embedding queue</div>
            <div>Queued: {queued}</div>
            <div>Running: {running}</div>
            <div>Failed: {failed}</div>
            <div>Success: {succeeded}</div>
            {nextRunnableAt && (
              <div>
                Next: <span className="font-mono">{nextRunnableAt}</span>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={retryLabel}
            className="h-5 w-5 p-0"
            disabled={retryDisabled}
            onClick={onRetry}
            size="sm"
            variant="ghost"
          >
            <RotateCw className="h-3 w-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          Retry failed jobs
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function QueueHudCard({
  metrics,
  retryDisabled,
  retryLabel,
  onRetry,
}: QueueHudViewProps): ReactElement {
  const { queued, running, failed, succeeded, nextRunnableAt } = metrics;

  return (
    <Card>
      <CardHeader className="border-b px-3 py-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <CardTitle className="font-medium text-xs">Queue</CardTitle>
            <Badge className="h-4 px-1 py-0 text-[9px]" variant="secondary">
              embeddings
            </Badge>
          </div>
          <Button
            aria-label={retryLabel}
            className="h-5 px-2 text-[10px]"
            disabled={retryDisabled}
            onClick={onRetry}
            size="sm"
            variant="outline"
          >
            Retry Failed
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-3 py-2 text-xs">
        <div className="grid grid-cols-4 gap-3">
          <div>
            <div className="text-[9px] text-muted-foreground">Queued</div>
            <div className="font-semibold text-sm">{queued}</div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Running</div>
            <div className="font-semibold text-sm">{running}</div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Failed</div>
            <div className="font-semibold text-destructive text-sm">{failed}</div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Success</div>
            <div className="font-semibold text-green-600 text-sm dark:text-green-400">
              {succeeded}
            </div>
          </div>
        </div>
        {nextRunnableAt && (
          <div className="mt-2 border-t pt-2 text-[9px] text-muted-foreground">
            Next: <span className="font-mono">{nextRunnableAt}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function QueueHud({ variant = 'card' }: QueueHudProps = {}): ReactElement | null {
  // Compute flag without hooks to avoid initializing DB when disabled
  const enabled = isQueueEnabled();

  const db = usePGliteDatabase();
  const { toast } = useToast();

  const jobQueue = useMemo(() => (db ? new JobQueue(db) : null), [db]);
  const nodeEnv = typeof process !== 'undefined' ? process.env?.['NODE_ENV'] : undefined;
  const shouldPoll = typeof window !== 'undefined' && nodeEnv !== 'test';

  const [stats, setStats] = useQueueStats(jobQueue, shouldPoll);
  const { busy, handleRetry } = useQueueRetry(jobQueue, setStats, toast);
  const metrics = getQueueMetrics(stats);

  if (!enabled) {
    return null;
  }

  const retryDisabled = busy || !jobQueue || metrics.failed === 0;
  const retryLabel = getRetryLabel(metrics.failed);

  return variant === 'status-bar' ? (
    <QueueHudStatusBar
      metrics={metrics}
      onRetry={handleRetry}
      retryDisabled={retryDisabled}
      retryLabel={retryLabel}
    />
  ) : (
    <QueueHudCard
      metrics={metrics}
      onRetry={handleRetry}
      retryDisabled={retryDisabled}
      retryLabel={retryLabel}
    />
  );
}
