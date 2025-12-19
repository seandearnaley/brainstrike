import { JobQueue, usePGliteDatabase } from '@brainstrike/db';
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
import { useEffect, useMemo, useState } from 'react';

type QueueStats = {
  queue: string;
  queued: number;
  running: number;
  failed: number;
  succeeded: number;
  nextRunnableAt?: string | null;
};

type QueueHudVariant = 'card' | 'status-bar';

type QueueHudProps = {
  variant?: QueueHudVariant;
};

const logger = createLogger('QueueHud');

const EMBEDDING_QUEUE_NAME = 'embeddings';
const RETRY_BATCH_SIZE = 20;
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

export function QueueHud({ variant = 'card' }: QueueHudProps = {}) {
  // Compute flag without hooks to avoid initializing DB when disabled
  const enabled = isQueueEnabled();

  const db = usePGliteDatabase();
  const { toast } = useToast();
  const [stats, setStats] = useState<QueueStats[] | null>(null);
  const [busy, setBusy] = useState(false);

  const jobQueue = useMemo(() => (db ? new JobQueue(db) : null), [db]);
  const nodeEnv = typeof process !== 'undefined' ? process.env?.['NODE_ENV'] : undefined;
  const shouldPoll = typeof window !== 'undefined' && nodeEnv !== 'test';

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
      } catch {
        // ignore errors in HUD
      }
    };

    void fetchStats();
    if (!shouldPoll) {
      return () => {
        canceled = true;
      };
    }

    const id = setInterval(fetchStats, QUEUE_POLL_INTERVAL_MS);
    return () => {
      canceled = true;
      clearInterval(id);
    };
  }, [jobQueue, shouldPoll]);

  const s = stats?.[0];
  if (!enabled) {
    return null;
  }

  const queued = s?.queued ?? 0;
  const running = s?.running ?? 0;
  const failed = s?.failed ?? 0;
  const succeeded = s?.succeeded ?? 0;
  const retryDisabled = busy || !jobQueue || failed === 0;

  const handleRetry = async (): Promise<void> => {
    if (!jobQueue) {
      return;
    }
    try {
      setBusy(true);
      await jobQueue.requeueFailed(EMBEDDING_QUEUE_NAME, RETRY_BATCH_SIZE);
      const nextStats = await jobQueue.getQueueStats(EMBEDDING_QUEUE_NAME);
      setStats(nextStats);
    } catch (error) {
      logger.error('Failed to retry embedding queue jobs', { error });
      const message = error instanceof Error ? error.message : String(error);
      toast({
        title: 'Failed to retry jobs',
        description: message || 'Unable to retry failed embedding jobs.',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  if (variant === 'status-bar') {
    return (
      <div className="flex items-center gap-2 text-[10px]" data-testid="status-bar-queue">
        <Tooltip>
          <TooltipTrigger asChild>
            <output
              aria-label={`Embedding queue: ${queued} queued, ${running} running, ${failed} failed, ${succeeded} succeeded`}
              className="flex items-center gap-2 rounded px-1 py-0.5 text-[10px] text-muted-foreground"
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
            </output>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            <div className="space-y-1 text-xs">
              <div className="font-medium">Embedding queue</div>
              <div>Queued: {queued}</div>
              <div>Running: {running}</div>
              <div>Failed: {failed}</div>
              <div>Success: {succeeded}</div>
              {s?.nextRunnableAt && (
                <div>
                  Next: <span className="font-mono">{s.nextRunnableAt}</span>
                </div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Retry failed jobs"
              className="h-5 w-5 p-0"
              disabled={retryDisabled}
              onClick={handleRetry}
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
            aria-label="Retry failed jobs"
            className="h-5 px-2 text-[10px]"
            disabled={retryDisabled}
            onClick={handleRetry}
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
        {s?.nextRunnableAt && (
          <div className="mt-2 border-t pt-2 text-[9px] text-muted-foreground">
            Next: <span className="font-mono">{s.nextRunnableAt}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
