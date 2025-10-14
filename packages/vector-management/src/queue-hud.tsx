import { JobQueue, usePGliteDatabase } from '@brainstrike/db';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@brainstrike/ui';
import { useEffect, useMemo, useState } from 'react';

type QueueStats = {
  queue: string;
  queued: number;
  running: number;
  failed: number;
  succeeded: number;
  nextRunnableAt?: string | null;
};

function isQueueEnabled(): boolean {
  try {
    // In browser contexts, treat the queue as enabled so HUD reflects runtime activity.
    if (typeof window !== 'undefined') return true;
    // @ts-expect-error process may not exist
    const v = process?.env?.EMBED_QUEUE_ENABLED;
    return String(v ?? 'false').toLowerCase() === 'true';
  } catch {
    return typeof window !== 'undefined';
  }
}

export function QueueHud() {
  // Compute flag without hooks to avoid initializing DB when disabled
  const enabled = isQueueEnabled();

  const db = usePGliteDatabase();
  const [stats, setStats] = useState<QueueStats[] | null>(null);
  const [busy, setBusy] = useState(false);

  const jobQueue = useMemo(() => (db ? new JobQueue(db) : null), [db]);
  const shouldPoll = typeof window !== 'undefined' && process.env.NODE_ENV !== 'test';

  useEffect(() => {
    if (!jobQueue) return;

    let canceled = false;
    const fetchStats = async () => {
      try {
        const s = await jobQueue.getQueueStats('embeddings');
        if (!canceled) setStats(s);
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

    const id = setInterval(fetchStats, 2000);
    return () => {
      canceled = true;
      clearInterval(id);
    };
  }, [jobQueue, shouldPoll]);

  const s = stats?.[0];
  if (!enabled) return null;
  return (
    <Card>
      <CardHeader className="py-1.5 px-3 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-xs font-medium">Queue</CardTitle>
            <Badge variant="secondary" className="text-[9px] py-0 px-1 h-4">
              embeddings
            </Badge>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !jobQueue || (s?.failed ?? 0) === 0}
            onClick={async () => {
              if (!jobQueue) return;
              try {
                setBusy(true);
                await jobQueue.requeueFailed('embeddings', 20);
                const s = await jobQueue.getQueueStats('embeddings');
                setStats(s);
              } finally {
                setBusy(false);
              }
            }}
            className="text-[10px] h-5 px-2"
            aria-label="Retry failed jobs"
          >
            Retry Failed
          </Button>
        </div>
      </CardHeader>
      <CardContent className="py-2 px-3 text-xs">
        <div className="grid grid-cols-4 gap-3">
          <div>
            <div className="text-[9px] text-muted-foreground">Queued</div>
            <div className="text-sm font-semibold">{s?.queued ?? 0}</div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Running</div>
            <div className="text-sm font-semibold">{s?.running ?? 0}</div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Failed</div>
            <div className="text-sm font-semibold text-destructive">{s?.failed ?? 0}</div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Success</div>
            <div className="text-sm font-semibold text-green-600 dark:text-green-400">
              {s?.succeeded ?? 0}
            </div>
          </div>
        </div>
        {s?.nextRunnableAt && (
          <div className="text-[9px] text-muted-foreground mt-2 pt-2 border-t">
            Next: <span className="font-mono">{s.nextRunnableAt}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
