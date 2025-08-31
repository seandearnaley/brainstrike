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
    // @ts-expect-error process may not exist
    const v = process?.env?.EMBED_QUEUE_ENABLED;
    return String(v ?? 'false').toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export function QueueHud() {
  // Compute flag without hooks to avoid initializing DB when disabled
  const enabled = isQueueEnabled();

  const db = usePGliteDatabase();
  const [stats, setStats] = useState<QueueStats[] | null>(null);
  const [busy, setBusy] = useState(false);

  const jobQueue = useMemo(() => (db ? new JobQueue(db) : null), [db]);

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
    const id = setInterval(fetchStats, 2000);
    return () => {
      canceled = true;
      clearInterval(id);
    };
  }, [jobQueue]);

  const s = stats?.[0];
  if (!enabled) return null;
  return (
    <Card className="mb-2">
      <CardHeader className="py-2 px-3">
        <div className="flex items-center gap-2 justify-between">
          <CardTitle className="text-sm">Queue</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">embeddings</Badge>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !jobQueue}
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
            >
              Retry last 20 failed
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="py-2 px-3 text-xs">
        <div className="flex gap-4">
          <div>
            Queued: <strong>{s?.queued ?? 0}</strong>
          </div>
          <div>
            Running: <strong>{s?.running ?? 0}</strong>
          </div>
          <div>
            Failed: <strong>{s?.failed ?? 0}</strong>
          </div>
          <div>
            Succeeded: <strong>{s?.succeeded ?? 0}</strong>
          </div>
        </div>
        {s?.nextRunnableAt && (
          <div className="text-muted-foreground mt-1">Next run at: {s.nextRunnableAt}</div>
        )}
      </CardContent>
    </Card>
  );
}
