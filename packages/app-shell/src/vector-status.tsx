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
  useToast,
} from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVectorPreferencesStore } from './stores/vector-preferences-store';
import { useVectorStatusUIStore } from './stores/vector-status-ui-store';
import { setActiveEmbeddingSetId } from './vector-preferences';
import { useEmbeddingWorkerControls } from './vector-status/use-embedding-worker-controls';
import { useVectorQueueState } from './vector-status/use-vector-queue-state';
import { createVectorQueueService } from './vector-status/vector-queue-service';

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
  hasDb,
  backfilling,
  backfillProgress,
  workerLocalRunning,
  onBackfill,
  hasChunks,
}: {
  activeId: string | null;
  hasDb: boolean;
  backfilling: boolean;
  backfillProgress: { done: number; total: number } | null;
  workerLocalRunning: boolean;
  onBackfill: () => Promise<void>;
  hasChunks: boolean;
}) {
  const isWeb =
    typeof window !== 'undefined' && !(window as { electronAPI?: unknown })?.electronAPI;

  const { disabled: isDisabled, title } = getBackfillDisabledState({
    activeId,
    hasDb,
    backfilling,
    isWeb,
    workerLocalRunning,
    hasChunks,
  });

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={isDisabled}
      onClick={() => {
        void onBackfill();
      }}
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

function getBackfillDisabledState(params: {
  activeId: string | null;
  hasDb: boolean;
  backfilling: boolean;
  isWeb: boolean;
  workerLocalRunning: boolean;
  hasChunks: boolean;
}): { disabled: boolean; title: string } {
  const { activeId, hasDb, backfilling, isWeb, workerLocalRunning, hasChunks } = params;
  // Evaluate reasons in priority order and early-return to keep complexity low
  if (!activeId) return { disabled: true, title: 'Select an active embedding set' };
  if (!hasDb) return { disabled: true, title: 'Database not ready yet' };
  if (backfilling) return { disabled: true, title: 'Backfilling in progress' };
  if (isWeb && !workerLocalRunning)
    return { disabled: true, title: 'Start worker to enable backfill on Web' };
  if (!hasChunks) return { disabled: true, title: 'No chunks available to backfill' };
  return {
    disabled: false,
    title: 'Enqueue jobs for chunks missing embeddings for the active set',
  };
}

function QueueControls({
  hasDb,
  queueCounts,
  onRetryFailed,
  onClearQueue,
  onWipeQueue,
}: {
  hasDb: boolean;
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
        disabled={!hasDb || queueCounts.failed === 0}
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
        disabled={!hasDb}
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
        disabled={!hasDb}
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

export function VectorStatusWithDb() {
  const vectorEnabled = useVectorEnabled();
  const db = usePGliteDatabase();
  const queueEnabled = isQueueEnabled();
  const { sets, activeId, setActiveId } = useActiveEmbeddingSet();
  const { toast } = useToast();

  const device = useMemo(() => TransformersBackend.getBestDevice(), []);
  const devicePref = useVectorPreferencesStore((s) => s.devicePref);
  const setDevicePref = useVectorPreferencesStore((s) => s.setDevicePref);
  const reinitEveryN = useVectorPreferencesStore((s) => s.reinitEveryN);
  const setReinitEveryN = useVectorPreferencesStore((s) => s.setReinitEveryN);
  const forceCpuAfterFailures = useVectorPreferencesStore((s) => s.forceCpuAfterFailures);
  const setForceCpuAfterFailures = useVectorPreferencesStore((s) => s.setForceCpuAfterFailures);
  const verboseOrtLogs = useVectorPreferencesStore((s) => s.verboseOrtLogs);
  const setVerboseOrtLogs = useVectorPreferencesStore((s) => s.setVerboseOrtLogs);

  useEffect(() => {
    try {
      TransformersBackend.setVerboseOrtLogs(verboseOrtLogs);
    } catch {}
  }, [verboseOrtLogs]);

  const service = useMemo(() => {
    if (!db) return null;
    return createVectorQueueService({
      db,
      jobQueue: new JobQueue(db),
      chunkRepository: new FileChunkRepository(db, vectorEnabled),
    });
  }, [db, vectorEnabled]);

  const backfillRef = useRef<() => Promise<void>>(async () => {});
  const invokeBackfill = useCallback(async () => {
    await backfillRef.current();
  }, []);

  const workerControls = useEmbeddingWorkerControls({
    db,
    devicePreference: devicePref,
    reinitEveryN,
    forceCpuAfterFailures,
    activeEmbeddingSetId: activeId,
    onBackfill: invokeBackfill,
    toast,
  });

  const queueState = useVectorQueueState({
    service,
    activeEmbeddingSetId: activeId,
    shouldAutoBackfill: workerControls.workerLocalRunning,
  });

  backfillRef.current = queueState.backfillActiveSet;

  const workerStatus = getWorkerStatus(
    queueEnabled,
    queueState.queueCounts,
    workerControls.startWorkerError,
    workerControls.startingWorker,
    workerControls.workerLocalRunning,
    queueState.throughput
  );

  const hasDb = Boolean(db);

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
        <div className="grid grid-cols-3 gap-1">
          <WorkerControls
            db={db}
            workerLocalRunning={workerControls.workerLocalRunning}
            startingWorker={workerControls.startingWorker}
            onStartWorker={workerControls.startWorker}
            onStopWorker={workerControls.stopWorker}
            onResetWorker={workerControls.resetWorker}
          />
        </div>
        <div className="grid grid-cols-2 gap-1">
          <BackfillButton
            activeId={activeId}
            hasDb={hasDb}
            backfilling={queueState.backfilling}
            backfillProgress={queueState.backfillProgress}
            workerLocalRunning={workerControls.workerLocalRunning}
            onBackfill={queueState.backfillActiveSet}
            hasChunks={queueState.coverage.total > 0}
          />
          <QueueControls
            hasDb={hasDb}
            queueCounts={queueState.queueCounts}
            onRetryFailed={() => queueState.retryFailed()}
            onClearQueue={() => queueState.clearQueue()}
            onWipeQueue={() => queueState.wipeQueue()}
          />
        </div>
        <div className="grid grid-cols-4 gap-2 pt-1 border-t">
          <div>
            <div className="text-[9px] text-muted-foreground">Coverage</div>
            <div className="text-[11px] font-medium">
              {queueState.coverage.withSet}/{queueState.coverage.total}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Jobs/min</div>
            <div className="text-[11px] font-medium">{queueState.throughput}</div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Queue</div>
            <div className="text-[11px] font-medium">
              {queueState.queueCounts.queued}/{queueState.queueCounts.running}/
              {queueState.queueCounts.failed}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Latency</div>
            <div className="text-[11px] font-medium">{queueState.latencyStats.p50Ms}ms</div>
          </div>
        </div>
        {(workerControls.startWorkerError || queueState.lastError) && (
          <div
            className="p-1 bg-destructive/10 border border-destructive/20 rounded text-[10px] text-destructive break-words"
            role="alert"
            aria-live="polite"
          >
            {workerControls.startWorkerError ?? queueState.lastError}
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
