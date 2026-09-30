import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import { JobQueue } from '@brainstrike/db';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
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
import { RotateCw } from 'lucide-react';
import { type ReactElement, useCallback, useMemo, useState } from 'react';

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
  succeededLifetime: number;
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

function isQueueEnabled(): boolean {
  try {
    // In browser contexts, treat the queue as enabled so HUD reflects runtime activity.
    if (typeof window !== 'undefined') {
      return true;
    }
    const env = typeof process === 'undefined' ? undefined : process.env;
    const v = env?.['EMBED_QUEUE_ENABLED'];
    return String(v ?? 'false').toLowerCase() === 'true';
  } catch {
    return typeof window !== 'undefined';
  }
}

function getRetryLabel(failed: number): string {
  if (failed <= 0) {
    return 'Retry failed jobs';
  }

  return `Retry ${failed} failed job${failed === 1 ? '' : 's'}`;
}

function useQueueRetry(
  jobQueue: JobQueue | null,
  toast: ToastFn
): { busy: boolean; handleRetry: () => Promise<void> } {
  const [busy, setBusy] = useState(false);
  const setDurableQueueStats = useVectorStatusUIStore((s) => s.setDurableQueueStats);

  const handleRetry = useCallback(async (): Promise<void> => {
    if (!jobQueue) {
      return;
    }
    try {
      setBusy(true);
      const repairedQueued = await jobQueue.repairUnclaimableQueued(
        EMBEDDING_QUEUE_NAME,
        RETRY_BATCH_SIZE
      );
      const requeuedFailed = await jobQueue.requeueFailed(EMBEDDING_QUEUE_NAME, RETRY_BATCH_SIZE);
      if (repairedQueued > 0 || requeuedFailed > 0) {
        logger.warn('Retry repaired embedding queue jobs', {
          repairedQueued,
          requeuedFailed,
        });
      }
      // Optimistically move failed→queued so the HUD reflects the retry immediately
      // instead of waiting for the next tracker poll (~1.5s).
      const currentStats = useVectorStatusUIStore.getState().durableQueueStats;
      if (currentStats) {
        const requeued = Math.min(currentStats.failed, requeuedFailed);
        setDurableQueueStats({
          ...currentStats,
          failed: currentStats.failed - requeued,
          queued: currentStats.queued + requeued,
        });
      }
      setBusy(false);
    } catch (error) {
      setBusy(false);
      logger.error('Failed to retry embedding queue jobs', { error });
      const message = error instanceof Error ? error.message : String(error);
      toast({
        description: message || 'Unable to retry failed embedding jobs.',
        title: 'Failed to retry jobs',
        variant: 'destructive',
      });
    }
  }, [jobQueue, toast, setDurableQueueStats]);

  return { busy, handleRetry };
}

function QueueHudStatusBar({
  metrics,
  retryDisabled,
  retryLabel,
  onRetry,
}: QueueHudViewProps): ReactElement {
  const { queued, running, failed, succeededLifetime, nextRunnableAt } = metrics;

  return (
    <div className="flex items-center gap-2 text-[10px]" data-testid="status-bar-queue">
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            aria-label={`Embedding queue: ${queued} queued, ${running} running, ${failed} failed, ${succeededLifetime} succeeded`}
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
              <span className="font-semibold text-foreground">{succeededLifetime}</span>
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          <div className="space-y-1 text-xs">
            <div className="font-medium">Embedding queue</div>
            <div>Queued: {queued}</div>
            <div>Running: {running}</div>
            <div>Failed: {failed}</div>
            <div>Success: {succeededLifetime}</div>
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
  const { queued, running, failed, succeededLifetime, nextRunnableAt } = metrics;

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
            <div className="font-semibold text-sm text-success">{succeededLifetime}</div>
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

  // BST-359: Read stats from the shared store (written by EmbeddingJobQueueTracker)
  const durableStats = useVectorStatusUIStore((s) => s.durableQueueStats);
  const { busy, handleRetry } = useQueueRetry(jobQueue, toast);
  const metrics: QueueMetrics = durableStats ?? {
    failed: 0,
    nextRunnableAt: null,
    queued: 0,
    running: 0,
    succeeded: 0,
    succeededLifetime: 0,
  };

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
