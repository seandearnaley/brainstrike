import {
  type EmbeddingSet,
  FileChunkRepository,
  JobQueue,
  usePGliteDatabase,
  useVectorEnabled,
} from '@brainstrike/db';
import type { EmbeddingWorkerController, EmbeddingWorkerOptions } from '@brainstrike/embeddings';
import { startEmbeddingWorker, TransformersBackend } from '@brainstrike/embeddings';
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
  useToast,
} from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVectorPreferencesStore } from './stores/vector-preferences-store';
import { useVectorStatusUIStore } from './stores/vector-status-ui-store';
import { setActiveEmbeddingSetId } from './vector-preferences';

type Coverage = { total: number; withSet: number };

// Small utils (no hooks) to keep cognitive complexity low
function* chunkArray<T>(arr: T[], size: number): Generator<T[]> {
  const n = Math.max(1, size);
  for (let i = 0; i < arr.length; i += n) {
    yield arr.slice(i, i + n);
  }
}

export async function withTransaction(
  db: NonNullable<ReturnType<typeof usePGliteDatabase>>,
  body: () => Promise<void>
): Promise<void> {
  await db.query('BEGIN');
  try {
    await body();
    await db.query('COMMIT');
  } catch (e) {
    try {
      await db.query('ROLLBACK');
    } catch {}
    throw e;
  }
}

export function handleQueueStateChange(
  stats: { queued?: number; running?: number },
  busyRef: { current: boolean },
  activeId: string | null
) {
  const isBusy = (stats.queued ?? 0) > 0 || (stats.running ?? 0) > 0;
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

function WorkerControls({
  db,
  workerLocalRunning,
  startingWorker,
  onStartWorker,
  onStopWorker,
  onResetWorker,
}: {
  db: NonNullable<ReturnType<typeof usePGliteDatabase>> | null;
  workerLocalRunning: boolean;
  startingWorker: boolean;
  onStartWorker: () => Promise<void>;
  onStopWorker: () => Promise<void>;
  onResetWorker: () => Promise<void>;
}) {
  if (typeof window === 'undefined' || isElectronRenderer()) {
    return null;
  }

  return (
    <>
      {!workerLocalRunning ? (
        <Button
          size="sm"
          variant={startingWorker ? 'outline' : 'secondary'}
          disabled={!db || startingWorker}
          onClick={onStartWorker}
          className="text-[10px] h-6 px-1.5 w-full"
          aria-label="Start embedding worker"
        >
          {startingWorker ? 'Starting…' : 'Start'}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={onStopWorker}
          className="text-[10px] h-6 px-1.5 w-full"
          aria-label="Stop embedding worker"
        >
          Stop
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={!db || startingWorker}
        onClick={onResetWorker}
        className="text-[10px] h-6 px-1.5 w-full"
        aria-label="Reset embedding worker"
      >
        Reset
      </Button>
    </>
  );
}

function BackfillButton({
  activeId,
  db,
  backfilling,
  backfillProgress,
  workerLocalRunning,
  onBackfill,
  hasChunks,
}: {
  activeId: string | null;
  db: NonNullable<ReturnType<typeof usePGliteDatabase>> | null;
  backfilling: boolean;
  backfillProgress: { done: number; total: number } | null;
  workerLocalRunning: boolean;
  onBackfill: () => void;
  hasChunks: boolean;
}) {
  const isWeb =
    typeof window !== 'undefined' && !(window as { electronAPI?: unknown })?.electronAPI;
  const isDisabled =
    !activeId || !db || backfilling || (isWeb && !workerLocalRunning) || !hasChunks;
  const title =
    isWeb && !workerLocalRunning
      ? 'Start worker to enable backfill on Web'
      : !hasChunks
        ? 'No chunks available to backfill'
        : 'Enqueue jobs for chunks missing embeddings for the active set';

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={isDisabled}
      onClick={onBackfill}
      title={title}
      className="text-[10px] h-6 px-1.5 w-full"
      aria-label={backfilling ? 'Backfilling in progress' : 'Backfill active embedding set'}
    >
      {backfilling
        ? backfillProgress
          ? `${backfillProgress.done}/${backfillProgress.total}`
          : 'Backfilling…'
        : 'Backfill'}
    </Button>
  );
}

function QueueControls({
  db,
  queueCounts,
  onRetryFailed,
  onClearQueue,
  onWipeQueue,
}: {
  db: NonNullable<ReturnType<typeof usePGliteDatabase>> | null;
  queueCounts: { failed: number };
  onRetryFailed: () => Promise<void>;
  onClearQueue: () => Promise<void>;
  onWipeQueue: () => Promise<void>;
}) {
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!db || queueCounts.failed === 0}
        onClick={onRetryFailed}
        className="text-[10px] h-6 px-1.5 w-full"
        aria-label="Retry failed jobs"
        title="Requeue the most recent failed jobs (up to 20)"
      >
        Retry
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!db}
        onClick={onClearQueue}
        className="text-[10px] h-6 px-1.5 w-full"
        aria-label="Clear queue"
        title="Clear failed (and queued if present) items in the embeddings queue"
      >
        Clear
      </Button>
      <Button
        size="sm"
        variant="destructive"
        disabled={!db}
        onClick={onWipeQueue}
        className="text-[10px] h-6 px-1.5 w-full"
        aria-label="Wipe queue"
        title="Delete all job_queue records for embeddings (all states)"
      >
        Wipe
      </Button>
    </>
  );
}

function getWorkerStatus(
  queueEnabled: boolean,
  queueCounts: { failed: number; running: number },
  startWorkerError: string | null,
  startingWorker: boolean,
  workerLocalRunning: boolean,
  throughput: number
): 'disabled' | 'initializing' | 'running' | 'error' {
  const isWeb =
    typeof window !== 'undefined' && !(window as { electronAPI?: unknown })?.electronAPI;
  if (!queueEnabled) return 'disabled';
  if (queueCounts.failed > 0 || startWorkerError) return 'error';
  if (startingWorker) return 'initializing';
  if (workerLocalRunning || queueCounts.running > 0 || throughput > 0) return 'running';
  return isWeb ? 'disabled' : 'initializing';
}

function isQueueEnabled(): boolean {
  try {
    // Prefer runtime detection in browsers to avoid build-time env false positives
    if (typeof window !== 'undefined') return true;
    // @ts-expect-error process may not exist in browser
    const v = process?.env?.EMBED_QUEUE_ENABLED;
    if (typeof v !== 'undefined') return String(v).toLowerCase() === 'true';
    return false;
  } catch {
    return typeof window !== 'undefined';
  }
}
function isElectronRenderer(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { electronAPI?: unknown };
  return !!w.electronAPI;
}

function useActiveEmbeddingSet() {
  const db = usePGliteDatabase();
  const [sets, setSets] = useState<EmbeddingSet[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Load sets
  useEffect(() => {
    let canceled = false;
    if (!db) return;
    const fetchSets = async () => {
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
      // Restore selection from store (preferred) or pick newest
      let saved: string | null = null;
      try {
        saved = useVectorStatusUIStore.getState().activeEmbeddingSetId;
      } catch {}
      const id = saved && mapped.find((s) => s.id === saved) ? saved : (mapped[0]?.id ?? null);
      setActiveId(id);
      return mapped.length;
    };

    // initial load
    void fetchSets().catch(() => {});

    // Poll briefly if empty (user may have just started the worker)
    let pollId: ReturnType<typeof setInterval> | null = null;

    const pollForSets = async () => {
      let attempts = 0;
      pollId = setInterval(async () => {
        attempts += 1;
        if (attempts > 10) {
          if (pollId) clearInterval(pollId);
          return;
        }
        const c = await fetchSets();
        if (c && c > 0 && pollId) {
          clearInterval(pollId);
        }
      }, 2000);
    };

    void (async () => {
      try {
        const count = await fetchSets();
        if (!canceled && count === 0) {
          await pollForSets();
        }
      } catch {}
    })();

    return () => {
      canceled = true;
      if (pollId) clearInterval(pollId);
    };
  }, [db]);

  // Persist selection
  useEffect(() => {
    setActiveEmbeddingSetId(activeId ?? null);
  }, [activeId]);

  const active = useMemo(() => sets.find((s) => s.id === activeId) ?? null, [sets, activeId]);
  return { sets, active, activeId, setActiveId } as const;
}

function useWorkerState() {
  const workerControllerRef = useRef<EmbeddingWorkerController | null>(null);
  const [workerLocalRunning, setWorkerLocalRunning] = useState(false);
  const [startingWorker, setStartingWorker] = useState(false);
  const [startWorkerError, setStartWorkerError] = useState<string | null>(null);

  return {
    workerControllerRef,
    workerLocalRunning,
    setWorkerLocalRunning,
    startingWorker,
    setStartingWorker,
    startWorkerError,
    setStartWorkerError,
  };
}

function useQueueState() {
  const [coverage, setCoverage] = useState<Coverage>({ total: 0, withSet: 0 });
  const [queueCounts, setQueueCounts] = useState({
    queued: 0,
    running: 0,
    failed: 0,
    succeeded: 0,
  });
  const [throughput, setThroughput] = useState<number>(0);
  const [latencyStats, setLatencyStats] = useState<{
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
  }>({ avgMs: 0, p50Ms: 0, p95Ms: 0 });
  const [lastError, setLastError] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{ done: number; total: number } | null>(
    null
  );

  return {
    coverage,
    setCoverage,
    queueCounts,
    setQueueCounts,
    throughput,
    setThroughput,
    latencyStats,
    setLatencyStats,
    lastError,
    setLastError,
    backfilling,
    setBackfilling,
    backfillProgress,
    setBackfillProgress,
  };
}

async function handleStartWorker({
  db,
  devicePref,
  reinitEveryN,
  forceCpuAfterFailures,
  activeId,
  setStartWorkerError,
  setStartingWorker,
  workerControllerRef,
  setWorkerLocalRunning,
  backfillActiveSet,
  toast,
}: {
  db: NonNullable<ReturnType<typeof usePGliteDatabase>>;
  devicePref: 'auto' | 'webgpu' | 'wasm' | 'cpu';
  reinitEveryN: number;
  forceCpuAfterFailures: number;
  activeId: string | null;
  setStartWorkerError: (error: string | null) => void;
  setStartingWorker: (starting: boolean) => void;
  workerControllerRef: React.MutableRefObject<EmbeddingWorkerController | null>;
  setWorkerLocalRunning: (running: boolean) => void;
  backfillActiveSet: () => Promise<void>;
  toast: (options: { title: string; description?: string; variant?: 'destructive' }) => void;
}) {
  try {
    setStartWorkerError(null);
    setStartingWorker(true);
    const startOpts: EmbeddingWorkerOptions = {
      db: db as NonNullable<typeof db>,
      enable: true,
      reinitEveryN,
      forceCpuAfterFailures,
      ...(devicePref !== 'auto' && { device: devicePref }),
    };
    const ctrl = await startEmbeddingWorker(startOpts);
    workerControllerRef.current = ctrl;
    setWorkerLocalRunning(true);
    try {
      window.dispatchEvent(new CustomEvent('brainstrike:queue-drained'));
    } catch {}
    try {
      if (activeId) await backfillActiveSet();
    } catch {}
    toast({
      title: 'Worker started',
      description: 'Local embedding worker is running.',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStartWorkerError(msg);
    toast({
      title: 'Failed to start worker',
      description: msg,
      variant: 'destructive',
    });
  } finally {
    setStartingWorker(false);
  }
}

export function VectorStatusWithDb() {
  const vectorEnabled = useVectorEnabled();
  const db = usePGliteDatabase();
  const queueEnabled = isQueueEnabled();
  const { sets, activeId, setActiveId } = useActiveEmbeddingSet();
  const { toast } = useToast();

  const {
    coverage,
    setCoverage,
    queueCounts,
    setQueueCounts,
    throughput,
    setThroughput,
    latencyStats,
    setLatencyStats,
    lastError,
    setLastError,
    backfilling,
    setBackfilling,
    backfillProgress,
    setBackfillProgress,
  } = useQueueState();

  const {
    workerControllerRef,
    workerLocalRunning,
    setWorkerLocalRunning,
    startingWorker,
    setStartingWorker,
    startWorkerError,
    setStartWorkerError,
  } = useWorkerState();

  const busyRef = useRef(false);
  const autoBackfillRef = useRef<string | null>(null);

  // Derive device (best-effort)
  const device = useMemo(() => TransformersBackend.getBestDevice(), []);

  // Embedding worker tuning (persisted)
  const devicePref = useVectorPreferencesStore((s) => s.devicePref);
  const setDevicePref = useVectorPreferencesStore((s) => s.setDevicePref);
  const reinitEveryN = useVectorPreferencesStore((s) => s.reinitEveryN);
  const setReinitEveryN = useVectorPreferencesStore((s) => s.setReinitEveryN);
  const forceCpuAfterFailures = useVectorPreferencesStore((s) => s.forceCpuAfterFailures);
  const setForceCpuAfterFailures = useVectorPreferencesStore((s) => s.setForceCpuAfterFailures);
  const verboseOrtLogs = useVectorPreferencesStore((s) => s.verboseOrtLogs);
  const setVerboseOrtLogs = useVectorPreferencesStore((s) => s.setVerboseOrtLogs);

  // Apply verbose flag to backend on mount/changes
  useEffect(() => {
    try {
      TransformersBackend.setVerboseOrtLogs(verboseOrtLogs);
    } catch {}
  }, [verboseOrtLogs]);

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
    for (const batch of chunkArray(rows, Batch)) {
      await withTransaction(dbRef, async () => {
        for (const row of batch) {
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
        }
      });
    }
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
        handleQueueStateChange(s, busyRef, activeId);
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

    const fetchLatency = async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      const latRes = await dbRef.query<{ runAt: string; updatedAt: string }>(
        `SELECT run_at AS "runAt", updated_at AS "updatedAt"
         FROM job_queue
         WHERE queue = 'embeddings' AND state = 'succeeded' AND updated_at >= $1
         ORDER BY updated_at DESC
         LIMIT 200`,
        [since]
      );
      const latencies = latRes.rows
        .map((r) => {
          const a = Date.parse(r.updatedAt);
          const b = Date.parse(r.runAt);
          const d = Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, a - b) : 0;
          return d;
        })
        .filter((v) => Number.isFinite(v) && v >= 0)
        .sort((x, y) => x - y);
      if (canceled) return;
      if (latencies.length === 0) {
        setLatencyStats({ avgMs: 0, p50Ms: 0, p95Ms: 0 });
        return;
      }
      const avg = Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length);
      const p = (q: number): number | undefined =>
        latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];
      const p50 = p(0.5) ?? avg;
      const p95 = p(0.95) ?? avg;
      setLatencyStats({ avgMs: avg, p50Ms: Math.round(p50), p95Ms: Math.round(p95) });
    };

    const refresh = async () => {
      try {
        await Promise.all([
          fetchCoverage(),
          fetchQueue(),
          fetchThroughput(),
          fetchLastError(),
          fetchLatency(),
        ]);
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

  // Auto-backfill when worker is running and a set becomes active but coverage is incomplete
  useEffect(() => {
    if (!db || !activeId || backfilling) return;
    if (!workerLocalRunning) return;
    if (autoBackfillRef.current === activeId) return;
    if (coverage.total > 0 && coverage.withSet < coverage.total) {
      autoBackfillRef.current = activeId;
      void backfillActiveSet();
    }
  }, [
    db,
    activeId,
    backfilling,
    workerLocalRunning,
    coverage.total,
    coverage.withSet,
    backfillActiveSet,
  ]);

  const workerStatus = getWorkerStatus(
    queueEnabled,
    queueCounts,
    startWorkerError,
    startingWorker,
    workerLocalRunning,
    throughput
  );

  return (
    <Card>
      <CardHeader className="py-1.5 px-3 border-b">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-medium">Vector Status</CardTitle>
          <div className="flex items-center gap-1">
            <Badge
              variant={vectorEnabled ? 'default' : 'outline'}
              className="text-[9px] py-0 px-1 h-4"
            >
              {vectorEnabled ? 'PG: ON' : 'PG: OFF'}
            </Badge>
            <Badge
              variant={
                workerStatus === 'running'
                  ? 'default'
                  : workerStatus === 'error'
                    ? 'destructive'
                    : 'secondary'
              }
              className="text-[9px] py-0 px-1 h-4"
            >
              {workerStatus === 'running' ? '● RUN' : workerStatus === 'error' ? '✕ ERR' : '○ OFF'}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="py-2 px-3 text-xs space-y-2">
        {/* Diagnostics */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={verboseOrtLogs}
              onChange={(e) => setVerboseOrtLogs(e.target.checked)}
              title="Enable verbose ONNX Runtime logs in console"
            />
            <span className="text-[10px] text-muted-foreground">Verbose ORT logs</span>
          </label>
          <span className="text-[10px] text-muted-foreground">
            EP Mix:
            {(() => {
              try {
                const anyTB = TransformersBackend as unknown as {
                  getRuntimeStats?: () => { epFallbackSeen: number; inferenceCount: number };
                };
                const s = anyTB.getRuntimeStats?.();
                if (!s || s.inferenceCount === 0) return ' n/a';
                return s.epFallbackSeen > 0 ? ' webgpu+wasm' : ' pure';
              } catch {
                return ' n/a';
              }
            })()}
          </span>
        </div>
        {/* Embedding Set & Controls Row */}
        <div className="flex gap-2 items-start">
          <div className="flex-1 min-w-0">
            <Label className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium block mb-1">
              Embedding Set
            </Label>
            <Select
              value={activeId ?? ''}
              onValueChange={(v) => setActiveId(v)}
              disabled={!sets.length}
            >
              <SelectTrigger className="h-7 w-full text-[11px]" aria-label="Select embedding set">
                <SelectValue placeholder="No sets" />
              </SelectTrigger>
              <SelectContent className="max-w-[280px]">
                {sets.map((s) => (
                  <SelectItem key={s.id} value={s.id} className="text-[11px]">
                    <div className="flex items-center gap-1">
                      <span className="font-medium">{s.modelKey}</span>
                      <span className="text-[9px] text-muted-foreground">({s.dimensions}d)</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-shrink-0">
            <Label className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium block mb-1">
              Device
            </Label>
            <Badge
              variant="outline"
              className="text-[10px] py-0.5 px-1.5 h-7 w-full justify-center"
            >
              {device}
            </Badge>
          </div>
        </div>

        {/* Worker tuning controls */}
        <div className="flex items-center gap-2">
          <Label className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">
            Pref
          </Label>
          <select
            aria-label="Preferred device"
            className="h-7 text-[11px] border rounded px-1"
            value={devicePref}
            onChange={(e) => setDevicePref(e.target.value as 'auto' | 'webgpu' | 'wasm' | 'cpu')}
          >
            <option value="auto">Auto</option>
            <option value="webgpu">WebGPU</option>
            <option value="wasm">WASM (CPU)</option>
            <option value="cpu">CPU (maps to WASM)</option>
          </select>
          <Label className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">
            Reinit
          </Label>
          <input
            type="number"
            className="h-7 w-16 text-[11px] border rounded px-1"
            min={50}
            max={10000}
            step={50}
            value={reinitEveryN}
            onChange={(e) => setReinitEveryN(Number(e.target.value) || 0)}
            title="Reinitialize model every N chunks"
          />
          <Label className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">
            CPU after
          </Label>
          <input
            type="number"
            className="h-7 w-16 text-[11px] border rounded px-1"
            min={1}
            max={20}
            step={1}
            value={forceCpuAfterFailures}
            onChange={(e) => setForceCpuAfterFailures(Number(e.target.value) || 1)}
            title="Switch to CPU/WASM after N consecutive failures"
          />
        </div>

        {/* Controls Grid */}
        <div className="grid grid-cols-3 gap-1">
          <WorkerControls
            db={db}
            workerLocalRunning={workerLocalRunning}
            startingWorker={startingWorker}
            onStartWorker={async () => {
              if (!db) return;
              await handleStartWorker({
                db,
                devicePref,
                reinitEveryN,
                forceCpuAfterFailures,
                activeId,
                setStartWorkerError,
                setStartingWorker,
                workerControllerRef,
                setWorkerLocalRunning,
                backfillActiveSet,
                toast,
              });
            }}
            onStopWorker={async () => {
              try {
                await workerControllerRef.current?.stop();
              } finally {
                workerControllerRef.current = null;
                setWorkerLocalRunning(false);
                toast({ title: 'Worker stopped' });
              }
            }}
            onResetWorker={async () => {
              try {
                setStartWorkerError(null);
                if (workerLocalRunning) {
                  await workerControllerRef.current?.stop();
                  workerControllerRef.current = null;
                  setWorkerLocalRunning(false);
                }
                setStartingWorker(true);
                const resetOpts: EmbeddingWorkerOptions = {
                  db: db as NonNullable<typeof db>,
                  enable: true,
                  reinitEveryN,
                  forceCpuAfterFailures,
                  ...(devicePref !== 'auto' && { device: devicePref }),
                };
                const ctrl = await startEmbeddingWorker(resetOpts);
                workerControllerRef.current = ctrl;
                setWorkerLocalRunning(true);
                toast({ title: 'Worker reset', description: 'Model re-initialized.' });
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                setStartWorkerError(msg);
                toast({
                  title: 'Worker reset failed',
                  description: msg,
                  variant: 'destructive',
                });
              } finally {
                setStartingWorker(false);
              }
            }}
          />
        </div>
        <div className="grid grid-cols-2 gap-1">
          <BackfillButton
            activeId={activeId}
            db={db}
            backfilling={backfilling}
            backfillProgress={backfillProgress}
            workerLocalRunning={workerLocalRunning}
            onBackfill={() => void backfillActiveSet()}
            hasChunks={coverage.total > 0}
          />
          <QueueControls
            db={db}
            queueCounts={queueCounts}
            onRetryFailed={async () => {
              if (!db) return;
              try {
                const jq = new JobQueue(db);
                await jq.requeueFailed('embeddings', 20);
              } catch {}
            }}
            onClearQueue={async () => {
              if (!db) return;
              try {
                const jq = new JobQueue(db);
                await jq.clear('embeddings', ['failed']);
                const stats = await jq.getQueueStats('embeddings');
                const s = stats[0];
                if ((s?.queued ?? 0) > 0) {
                  await jq.clear('embeddings', ['queued']);
                }
              } catch {}
            }}
            onWipeQueue={async () => {
              if (!db) return;
              try {
                const jq = new JobQueue(db);
                await jq.clear('embeddings');
              } catch {}
            }}
          />
        </div>

        {/* Compact Stats */}
        <div className="grid grid-cols-4 gap-2 pt-1 border-t">
          <div>
            <div className="text-[9px] text-muted-foreground">Coverage</div>
            <div className="text-[11px] font-medium">
              {coverage.withSet}/{coverage.total}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Jobs/min</div>
            <div className="text-[11px] font-medium">{throughput}</div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Queue</div>
            <div className="text-[11px] font-medium">
              {queueCounts.queued}/{queueCounts.running}/{queueCounts.failed}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Latency</div>
            <div className="text-[11px] font-medium">{latencyStats.p50Ms}ms</div>
          </div>
        </div>

        {/* Error Display */}
        {(startWorkerError || lastError) && (
          <div
            className="p-1 bg-destructive/10 border border-destructive/20 rounded text-[10px] text-destructive break-words"
            role="alert"
            aria-live="polite"
          >
            {startWorkerError ?? lastError}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Safe, hook-less variant for contexts without DbProvider (e.g., shallow tests)
export function VectorStatus() {
  const device = useMemo(() => TransformersBackend.getBestDevice(), []);
  return (
    <Card>
      <CardHeader className="py-1.5 px-3 border-b">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-medium">Vector Status</CardTitle>
          <div className="flex items-center gap-1">
            <Badge variant={'outline'} className="text-[9px] py-0 px-1 h-4">
              pgvector: off
            </Badge>
            <Badge variant={'secondary'} className="text-[9px] py-0 px-1 h-4">
              worker: disabled
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="py-2 px-3 text-xs">
        <div className="flex items-center gap-2">
          <Label className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">
            Device:
          </Label>
          <Badge variant="outline" className="text-[10px] py-0.5 px-1.5">
            {device}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
