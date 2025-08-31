import {
  type EmbeddingSet,
  FileChunkRepository,
  JobQueue,
  usePGliteDatabase,
  useVectorEnabled,
} from '@brainstrike/db';
import { TransformersBackend } from '@brainstrike/embeddings';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { setActiveEmbeddingSetId } from './vector-preferences';

type Coverage = { total: number; withSet: number };

function isQueueEnabled(): boolean {
  try {
    // @ts-expect-error process may not exist in browser
    const v = process?.env?.EMBED_QUEUE_ENABLED;
    return String(v ?? 'false').toLowerCase() === 'true';
  } catch {
    return false;
  }
}

function useActiveEmbeddingSet() {
  const db = usePGliteDatabase();
  const [sets, setSets] = useState<EmbeddingSet[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Load sets
  useEffect(() => {
    let canceled = false;
    if (!db) return;
    (async () => {
      const res = await db.query<{
        id: string;
        modelKey: string;
        modelId: string;
        dimensions: number;
        distance: string;
        createdAt: string;
      }>(
        'SELECT id, model_key AS "modelKey", model_id AS "modelId", dimensions, distance, created_at AS "createdAt" FROM embedding_sets ORDER BY created_at DESC'
      );
      if (canceled) return;
      const mapped: EmbeddingSet[] = res.rows.map((r) => ({
        id: String(r.id),
        modelKey: String(r.modelKey),
        modelId: String(r.modelId),
        dimensions: Number(r.dimensions),
        distance: String(r.distance) as EmbeddingSet['distance'],
        createdAt: String(r.createdAt),
      }));
      setSets(mapped);
      // Restore selection or pick newest
      const saved = localStorage.getItem('brainstrike.activeEmbeddingSetId');
      const id = saved && mapped.find((s) => s.id === saved) ? saved : (mapped[0]?.id ?? null);
      setActiveId(id);
    })().catch(() => {});
    return () => {
      canceled = true;
    };
  }, [db]);

  // Persist selection
  useEffect(() => {
    setActiveEmbeddingSetId(activeId ?? null);
  }, [activeId]);

  const active = useMemo(() => sets.find((s) => s.id === activeId) ?? null, [sets, activeId]);
  return { sets, active, activeId, setActiveId } as const;
}

export function VectorStatusWithDb() {
  const vectorEnabled = useVectorEnabled();
  const db = usePGliteDatabase();
  const queueEnabled = isQueueEnabled();
  const { sets, active, activeId, setActiveId } = useActiveEmbeddingSet();

  const [coverage, setCoverage] = useState<Coverage>({ total: 0, withSet: 0 });
  const [queueCounts, setQueueCounts] = useState({
    queued: 0,
    running: 0,
    failed: 0,
    succeeded: 0,
  });
  const [throughput, setThroughput] = useState<number>(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  // Track queue busy state across polls for auto-refresh event
  const busyRef = useRef(false);

  // Derive device (best-effort)
  const device = useMemo(() => TransformersBackend.getBestDevice(), []);

  // Local helper (not a hook): batched enqueue with progress
  const enqueueBackfillLocal = async (
    dbRef: NonNullable<ReturnType<typeof usePGliteDatabase>>,
    jq: JobQueue,
    rows: Array<{ id: string; fileRecordId: string; contentHash: string }>,
    setId: string,
    onProgress: (done: number, total: number) => void
  ) => {
    const total = rows.length;
    let done = 0;
    onProgress(done, total);
    const Batch = 500;
    await dbRef.query('BEGIN');
    for (let i = 0; i < total; i++) {
      const row = rows[i];
      if (!row) break;
      const dedupe = `${row.id}:${setId}:${row.contentHash}`;
      await jq.enqueue({
        queue: 'embeddings',
        jobType: 'embed_chunk',
        payload: {
          chunkId: String(row.id),
          fileRecordId: String(row.fileRecordId),
          embeddingSetId: setId,
        },
        dedupeKey: dedupe,
      });
      done += 1;
      if (done % 50 === 0) onProgress(done, total);
      if (i > 0 && i % Batch === 0) {
        await dbRef.query('COMMIT');
        await dbRef.query('BEGIN');
      }
    }
    await dbRef.query('COMMIT');
  };

  const backfillActiveSet = useCallback(async () => {
    if (!db || !activeId) return;
    setBackfilling(true);
    setBackfillProgress(null);
    try {
      const jq = new JobQueue(db);
      // Get candidates and enqueue in batches with progress updates
      const res = await db.query<{
        id: string;
        fileRecordId: string;
        contentHash: string;
      }>(
        `SELECT c.id,
                c.file_record_id AS "fileRecordId",
                c.content_hash   AS "contentHash"
         FROM file_chunks c
         WHERE c.embedding_set_id IS DISTINCT FROM $1
           AND NOT EXISTS (
             SELECT 1 FROM job_queue j
              WHERE j.queue = 'embeddings'
                AND j.state IN ('queued','running')
                AND j.dedupe_key = (c.id || ':' || $1 || ':' || c.content_hash)
           )`,
        [activeId]
      );
      await enqueueBackfillLocal(db, jq, res.rows, activeId, (d, t) =>
        setBackfillProgress({ done: d, total: t })
      );
      const s = (await jq.getQueueStats('embeddings'))[0];
      if (s)
        setQueueCounts({
          queued: s.queued,
          running: s.running,
          failed: s.failed,
          succeeded: s.succeeded,
        });
    } catch {
      // ignore
    } finally {
      setBackfilling(false);
      setTimeout(() => setBackfillProgress(null), 1000);
    }
  }, [db, activeId]);

  useEffect(() => {
    let canceled = false;
    if (!db) return;
    const dbRef = db; // non-null within this effect scope
    const jq = new JobQueue(dbRef);

    const fetchCoverage = async () => {
      if (!activeId) return;
      const repo = new FileChunkRepository(dbRef, vectorEnabled);
      const cov = await repo.getCoverageForSet(activeId);
      if (!canceled)
        setCoverage({ total: cov.totalChunks, withSet: cov.chunksWithEmbeddingsForSet });
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Minimal event logic; further splitting would reduce readability.
    const fetchQueue = async () => {
      const stats = await jq.getQueueStats('embeddings');
      const s = stats[0];
      if (!canceled && s) {
        setQueueCounts({
          queued: s.queued,
          running: s.running,
          failed: s.failed,
          succeeded: s.succeeded,
        });
        const isBusy = (s.queued ?? 0) > 0 || (s.running ?? 0) > 0;
        if (!isBusy && busyRef.current) {
          try {
            window.dispatchEvent(
              new CustomEvent('brainstrike:queue-drained', {
                detail: { queue: 'embeddings', embeddingSetId: activeId },
              })
            );
          } catch {}
        }
        busyRef.current = isBusy;
      }
    };

    const fetchThroughput = async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      const thrRes = await dbRef.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM job_queue WHERE queue = 'embeddings' AND state = 'succeeded' AND updated_at >= $1`,
        [since]
      );
      if (!canceled) setThroughput(Number(thrRes.rows[0]?.count ?? 0));
    };

    const fetchLastError = async () => {
      const errRes = await dbRef.query<{ error: string | null }>(
        `SELECT error FROM job_queue WHERE state = 'failed' ORDER BY updated_at DESC LIMIT 1`
      );
      if (!canceled) setLastError(errRes.rows[0]?.error ?? null);
    };

    const refresh = async () => {
      try {
        await Promise.all([fetchCoverage(), fetchQueue(), fetchThroughput(), fetchLastError()]);
      } catch {
        // ignore in HUD
      }
    };

    void refresh();
    const id = setInterval(refresh, 2500);
    return () => {
      canceled = true;
      clearInterval(id);
    };
  }, [db, activeId, vectorEnabled]);

  // Compute worker status badge
  const workerStatus: 'disabled' | 'initializing' | 'running' | 'error' = (() => {
    if (!queueEnabled) return 'disabled';
    if (queueCounts.failed > 0) return 'error';
    if (queueCounts.running > 0 || throughput > 0) return 'running';
    return 'initializing';
  })();

  return (
    <Card className="mb-2">
      <CardHeader className="py-2 px-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Vector Status</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={vectorEnabled ? 'default' : 'outline'}>
              {vectorEnabled ? 'pgvector: on' : 'pgvector: off'}
            </Badge>
            <Badge
              variant={
                workerStatus === 'running'
                  ? 'default'
                  : workerStatus === 'error'
                    ? 'destructive'
                    : 'secondary'
              }
            >
              worker: {workerStatus}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="py-2 px-3 text-xs space-y-2">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Embedding Set (search/backfill)
            </Label>
            <div className="flex items-center gap-2">
              <Select
                value={activeId ?? ''}
                onValueChange={(v) => setActiveId(v)}
                disabled={!sets.length}
              >
                <SelectTrigger className="h-7 w-[220px]">
                  <SelectValue placeholder="No sets" />
                </SelectTrigger>
                <SelectContent>
                  {sets.map((s) => (
                    <SelectItem key={s.id} value={s.id} textValue={s.id}>
                      {s.modelKey} · {s.dimensions}d · {s.distance}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={!activeId || !db || backfilling}
                onClick={() => void backfillActiveSet()}
                title="Enqueue jobs for chunks missing embeddings for the active set"
              >
                {backfilling
                  ? backfillProgress
                    ? `Backfilling… (${backfillProgress.done}/${backfillProgress.total})`
                    : 'Backfilling…'
                  : 'Backfill Active Set'}
              </Button>
            </div>
            {active && (
              <div className="text-muted-foreground">
                <span
                  title={active.id}
                  className="truncate inline-block max-w-[240px] align-bottom"
                >
                  {active.id}
                </span>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Device
            </Label>
            <div>
              <Badge variant="secondary">{device}</Badge>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 pt-1">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Coverage (selected set)
            </div>
            <div>
              <strong>{coverage.withSet}</strong>
              <span className="text-muted-foreground"> / {coverage.total}</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Throughput (60s)
            </div>
            <div>
              <strong>{throughput}</strong>
              <span className="text-muted-foreground"> jobs</span>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Queue</div>
            <div className="flex gap-3">
              <span>Q: {queueCounts.queued}</span>
              <span>R: {queueCounts.running}</span>
              <span>F: {queueCounts.failed}</span>
            </div>
          </div>
        </div>

        {lastError && (
          <div className="mt-1 text-[11px] text-red-600 truncate" title={lastError}>
            Last error: {lastError}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Safe, hook-less variant for contexts without DbProvider (e.g., shallow tests)
export function VectorStatus() {
  const device = useMemo(() => TransformersBackend.getBestDevice(), []);
  const workerStatus: 'disabled' | 'initializing' | 'running' | 'error' = 'disabled';
  return (
    <Card className="mb-2">
      <CardHeader className="py-2 px-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Vector Status</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={'outline'}>pgvector: off</Badge>
            <Badge variant={'secondary'}>worker: {workerStatus}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="py-2 px-3 text-xs space-y-2">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Device
            </Label>
            <div>
              <Badge variant="secondary">{device}</Badge>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
