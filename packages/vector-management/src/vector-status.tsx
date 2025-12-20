import {
  FileChunkRepository,
  JobQueue,
  useFileChunkRepository,
  usePGliteDatabase,
  useVectorEnabled,
} from '@brainstrike/db';
import { TransformersBackend } from '@brainstrike/embeddings';
import { useVectorPreferencesStore } from '@brainstrike/preferences';
import type { QueueAdapter } from '@brainstrike/queue';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Label,
  useToast,
} from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { EmbeddingQueueProvider } from './embedding-queue-provider';
import { getBackfillDisabledState } from './vector-status/backfill-utils';
import {
  EmbeddingSetSelector,
  useEmbeddingSetSelection,
} from './vector-status/embedding-set-selector';
import { useEmbeddingWorkerControls } from './vector-status/use-embedding-worker-controls';
import { useVectorQueueState } from './vector-status/use-vector-queue-state';
import { createVectorQueueService } from './vector-status/vector-queue-service';

type QueueAddReturn = Awaited<ReturnType<QueueAdapter['add']>>;
type QueueAddBulkReturn = Awaited<ReturnType<QueueAdapter['addBulk']>>;

const DISABLED_QUEUE_RESULT = {
  type: 'result',
  id: 'queue-disabled',
  vectors: [],
  metadata: {
    model: 'disabled',
    device: 'wasm',
    dtype: 'fp16',
    batchSize: 0,
    elapsedMs: 0,
    fallbackApplied: false,
    dimensions: 0,
  },
} as QueueAddReturn;

function createDisabledQueueAdapter(): QueueAdapter {
  return {
    async add(): Promise<QueueAddReturn> {
      return DISABLED_QUEUE_RESULT;
    },
    async addBulk(tasks): Promise<QueueAddBulkReturn> {
      return tasks.map(() => DISABLED_QUEUE_RESULT) as QueueAddBulkReturn;
    },
    onProgress() {
      return () => {};
    },
    pause() {},
    resume() {},
    async drain() {},
  };
}

function formatPerMinute(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0.0';
  }
  if (value >= 10) {
    return value.toFixed(0);
  }
  return value.toFixed(1);
}

function formatLatencyMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '—';
  }
  return `${Math.round(value)}`;
}

function Sparkline({
  values,
  ariaLabel,
  width = 60,
  height = 18,
  strokeWidth = 1.5,
  className,
}: {
  readonly values: readonly number[];
  readonly ariaLabel: string;
  readonly width?: number;
  readonly height?: number;
  readonly strokeWidth?: number;
  readonly className?: string;
}) {
  const sanitized =
    values.length > 0
      ? values.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0))
      : [0];
  const min = Math.min(...sanitized);
  const max = Math.max(...sanitized);
  const range = max - min;
  const step = sanitized.length > 1 ? width / (sanitized.length - 1) : width;
  const points = sanitized.map((value, index) => {
    const x = sanitized.length === 1 ? width / 2 : index * step;
    const normalized = range === 0 ? 0.5 : (value - min) / range;
    const clamped = Number.isFinite(normalized) ? Math.min(Math.max(normalized, 0), 1) : 0.5;
    const y = height - clamped * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <svg
      aria-label={ariaLabel}
      className={['block', className ?? ''].filter(Boolean).join(' ')}
      height={height}
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <polyline
        fill="none"
        points={points.join(' ')}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
    </svg>
  );
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
      {workerLocalRunning ? (
        <Button
          aria-label="Stop embedding worker"
          className="h-6 w-full px-1.5 text-[10px]"
          onClick={onStopWorker}
          size="sm"
          variant="outline"
        >
          Stop
        </Button>
      ) : (
        <Button
          aria-label="Start embedding worker"
          className="h-6 w-full px-1.5 text-[10px]"
          disabled={!db || startingWorker}
          onClick={onStartWorker}
          size="sm"
          variant={startingWorker ? 'outline' : 'secondary'}
        >
          {startingWorker ? 'Starting…' : 'Start'}
        </Button>
      )}
      <Button
        aria-label="Reset embedding worker"
        className="h-6 w-full px-1.5 text-[10px]"
        disabled={!db || startingWorker}
        onClick={onResetWorker}
        size="sm"
        variant="outline"
      >
        Reset
      </Button>
    </>
  );
}

function BackfillButton({
  activeId,
  activeLabel,
  hasDb,
  backfilling,
  backfillProgress,
  onBackfill,
  coverage,
  queueCounts,
}: {
  activeId: string | null;
  activeLabel?: string | null;
  hasDb: boolean;
  backfilling: boolean;
  backfillProgress: { done: number; total: number } | null;
  onBackfill: () => Promise<void>;
  coverage: { total: number; withSet: number };
  queueCounts: { queued: number; running: number };
}) {
  const { disabled: isDisabled, title } = getBackfillDisabledState({
    activeId,
    hasDb,
    backfilling,
    coverage,
    queueCounts,
  });
  const normalizedLabel = activeLabel?.trim() ?? '';
  const labelPreview =
    normalizedLabel.length > 24 ? `${normalizedLabel.slice(0, 21)}…` : normalizedLabel;
  const descriptiveLabel = normalizedLabel
    ? `Backfill ${labelPreview}`
    : 'Backfill current collection';
  const ariaLabel = backfilling
    ? activeLabel
      ? `Backfilling ${activeLabel}`
      : 'Backfilling current collection'
    : descriptiveLabel;
  const resolvedTitle = title ?? descriptiveLabel;

  return (
    <Button
      aria-label={ariaLabel}
      className="h-6 w-full px-1.5 text-[10px]"
      disabled={isDisabled}
      onClick={() => {
        void onBackfill();
      }}
      size="sm"
      title={resolvedTitle}
      variant="outline"
    >
      {backfilling
        ? backfillProgress
          ? `${backfillProgress.done}/${backfillProgress.total}`
          : 'Backfilling…'
        : normalizedLabel
          ? `Backfill ${labelPreview}`
          : 'Backfill'}
    </Button>
  );
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
        aria-label="Retry failed jobs"
        className="h-6 w-full px-1.5 text-[10px]"
        disabled={!hasDb || queueCounts.failed === 0}
        onClick={onRetryFailed}
        size="sm"
        title="Requeue the most recent failed jobs (up to 20)"
        variant="outline"
      >
        Retry
      </Button>
      <Button
        aria-label="Clear queue"
        className="h-6 w-full px-1.5 text-[10px]"
        disabled={!hasDb}
        onClick={onClearQueue}
        size="sm"
        title="Clear failed (and queued if present) items in the embeddings queue"
        variant="outline"
      >
        Clear
      </Button>
      <Button
        aria-label="Wipe queue"
        className="h-6 w-full px-1.5 text-[10px]"
        disabled={!hasDb}
        onClick={onWipeQueue}
        size="sm"
        title="Delete all job_queue records for embeddings (all states)"
        variant="destructive"
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
  if (!queueEnabled) {
    return 'disabled';
  }
  if (queueCounts.failed > 0 || startWorkerError) {
    return 'error';
  }
  if (startingWorker) {
    return 'initializing';
  }
  if (workerLocalRunning || queueCounts.running > 0 || throughput > 0) {
    return 'running';
  }
  return isWeb ? 'disabled' : 'initializing';
}

function isQueueEnabled(): boolean {
  try {
    // Prefer runtime detection in browsers to avoid build-time env false positives
    if (typeof window !== 'undefined') {
      return true;
    }
    const env = typeof process !== 'undefined' ? process.env : undefined;
    const v = env?.['EMBED_QUEUE_ENABLED'];
    if (typeof v !== 'undefined') {
      return String(v).toLowerCase() === 'true';
    }
    return false;
  } catch {
    return typeof window !== 'undefined';
  }
}
function isElectronRenderer(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const w = window as unknown as { electronAPI?: unknown };
  return !!w.electronAPI;
}

export function formatRelativeTimeFromNow(input: string | null): string {
  if (!input) {
    return 'never';
  }
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) {
    return 'unknown';
  }

  const diffMs = Date.now() - parsed;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (diffMs < 0) {
    return 'just now';
  }
  if (diffMs < minute) {
    return 'just now';
  }
  if (diffMs < hour) {
    const minutes = Math.floor(diffMs / minute);
    return `${minutes}m ago`;
  }
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return `${hours}h ago`;
  }
  if (diffMs < week) {
    const days = Math.floor(diffMs / day);
    return `${days}d ago`;
  }

  try {
    return new Date(parsed).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return new Date(parsed).toISOString().split('T')[0] ?? 'unknown';
  }
}

// Note: Collection selection is now managed by the useEmbeddingSetSelection hook
// and the EmbeddingSetSelector component from ./vector-status/embedding-set-selector.tsx

type VectorStatusWithDbProps = {
  queueAdapter?: QueueAdapter | null;
};

export function VectorStatusWithDb({ queueAdapter = null }: VectorStatusWithDbProps = {}) {
  const queueEnabled = isQueueEnabled();
  const fallbackQueueAdapter = useMemo<QueueAdapter | undefined>(
    () => (queueEnabled ? undefined : createDisabledQueueAdapter()),
    [queueEnabled]
  );
  const providerAdapter = queueAdapter ?? fallbackQueueAdapter;

  const providerProps = providerAdapter ? { adapter: providerAdapter } : undefined;

  const contentProps: VectorStatusWithDbContentProps = {
    queueEnabled,
  };

  return (
    <EmbeddingQueueProvider {...providerProps}>
      <VectorStatusWithDbContent {...contentProps} />
    </EmbeddingQueueProvider>
  );
}

type VectorStatusWithDbContentProps = {
  queueEnabled: boolean;
};

function VectorStatusWithDbContent({ queueEnabled }: VectorStatusWithDbContentProps) {
  const vectorEnabled = useVectorEnabled();
  const db = usePGliteDatabase();
  const chunkRepository = useFileChunkRepository();
  const { toast } = useToast();

  // Self-contained collection selection - no longer depends on Database Explorer
  const { selectedId: activeId, setSelectedId: setActiveId } = useEmbeddingSetSelection();

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

  const coverageRepository = useMemo(() => {
    if (chunkRepository && 'getCoverageForSet' in chunkRepository) {
      return chunkRepository;
    }
    const raw = db?.raw as { query?: unknown } | undefined;
    if (raw && typeof (raw as { query?: unknown }).query === 'function' && vectorEnabled) {
      try {
        return new FileChunkRepository(raw as ConstructorParameters<typeof FileChunkRepository>[0]);
      } catch {
        return null;
      }
    }
    return null;
  }, [chunkRepository, db, vectorEnabled]);

  const service = useMemo(() => {
    if (!(db && coverageRepository)) {
      return null;
    }
    return createVectorQueueService({
      db,
      jobQueue: new JobQueue(db),
      chunkRepository: coverageRepository,
    });
  }, [coverageRepository, db]);

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

  const throughputTrend = useMemo(
    () => queueState.telemetryTrend.map((point) => point.throughput),
    [queueState.telemetryTrend]
  );
  const errorTrend = useMemo(
    () => queueState.telemetryTrend.map((point) => point.errorCount),
    [queueState.telemetryTrend]
  );
  const latencyTrend = useMemo(
    () => queueState.telemetryTrend.map((point) => point.latencyP95),
    [queueState.telemetryTrend]
  );

  const workerStatus = getWorkerStatus(
    queueEnabled,
    queueState.queueCounts,
    workerControls.startWorkerError,
    workerControls.startingWorker,
    workerControls.workerLocalRunning,
    queueState.throughput
  );

  const hasDb = Boolean(db);

  const content = (
    <Card>
      <CardHeader className="border-b px-3 py-1.5">
        <div className="flex items-center justify-between">
          <CardTitle className="font-medium text-xs">Vector Status</CardTitle>
          <div className="flex items-center gap-1">
            <Badge
              className="h-4 px-1 py-0 text-[9px]"
              variant={vectorEnabled ? 'default' : 'outline'}
            >
              {vectorEnabled ? 'PG: ON' : 'PG: OFF'}
            </Badge>
            <Badge
              className="h-4 px-1 py-0 text-[9px]"
              variant={
                workerStatus === 'running'
                  ? 'default'
                  : workerStatus === 'error'
                    ? 'destructive'
                    : 'secondary'
              }
            >
              {workerStatus === 'running' ? '● RUN' : workerStatus === 'error' ? '✕ ERR' : '○ OFF'}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 px-3 py-2 text-xs">
        {/* Self-contained collection selector */}
        <div className="space-y-1">
          <div className="font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
            Active Collection
          </div>
          <EmbeddingSetSelector db={db} onSelectionChange={setActiveId} selectedId={activeId} />
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1">
            <input
              checked={verboseOrtLogs}
              className="h-3 w-3"
              onChange={(e) => setVerboseOrtLogs(e.target.checked)}
              title="Enable verbose ONNX Runtime logs in console"
              type="checkbox"
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
                if (!s || s.inferenceCount === 0) {
                  return ' n/a';
                }
                return s.epFallbackSeen > 0 ? ' webgpu+wasm' : ' pure';
              } catch {
                return ' n/a';
              }
            })()}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Label className="font-medium text-[9px] text-muted-foreground uppercase tracking-wider">
            Pref
          </Label>
          <select
            aria-label="Preferred device"
            className="h-7 rounded border px-1 text-[11px]"
            onChange={(e) => setDevicePref(e.target.value as 'auto' | 'webgpu' | 'wasm' | 'cpu')}
            value={devicePref}
          >
            <option value="auto">Auto</option>
            <option value="webgpu">WebGPU</option>
            <option value="wasm">WASM (CPU)</option>
            <option value="cpu">CPU (maps to WASM)</option>
          </select>
          <Label className="font-medium text-[9px] text-muted-foreground uppercase tracking-wider">
            Reinit
          </Label>
          <input
            className="h-7 w-16 rounded border px-1 text-[11px]"
            max={10_000}
            min={50}
            onChange={(e) => setReinitEveryN(Number(e.target.value) || 0)}
            step={50}
            title="Reinitialize model every N chunks"
            type="number"
            value={reinitEveryN}
          />
          <Label className="font-medium text-[9px] text-muted-foreground uppercase tracking-wider">
            CPU after
          </Label>
          <input
            className="h-7 w-16 rounded border px-1 text-[11px]"
            max={20}
            min={1}
            onChange={(e) => setForceCpuAfterFailures(Number(e.target.value) || 1)}
            step={1}
            title="Switch to CPU/WASM after N consecutive failures"
            type="number"
            value={forceCpuAfterFailures}
          />
        </div>
        <div className="grid grid-cols-3 gap-1">
          <WorkerControls
            db={db}
            onResetWorker={workerControls.resetWorker}
            onStartWorker={workerControls.startWorker}
            onStopWorker={workerControls.stopWorker}
            startingWorker={workerControls.startingWorker}
            workerLocalRunning={workerControls.workerLocalRunning}
          />
        </div>
        <div className="grid grid-cols-2 gap-1">
          <BackfillButton
            activeId={activeId}
            activeLabel={null}
            backfilling={queueState.backfilling}
            backfillProgress={queueState.backfillProgress}
            coverage={queueState.coverage}
            hasDb={hasDb}
            onBackfill={queueState.backfillActiveSet}
            queueCounts={queueState.queueCounts}
          />
          <QueueControls
            hasDb={hasDb}
            onClearQueue={() => queueState.clearQueue()}
            onRetryFailed={() => queueState.retryFailed()}
            onWipeQueue={() => queueState.wipeQueue()}
            queueCounts={queueState.queueCounts}
          />
        </div>
        <div className="grid grid-cols-4 gap-2 border-t pt-1">
          <div>
            <div className="text-[9px] text-muted-foreground">Coverage</div>
            <div className="font-medium text-[11px]">
              {queueState.coverage.withSet}/{queueState.coverage.total}
            </div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Queue</div>
            <div className="font-medium text-[11px]">
              {queueState.queueCounts.queued}/{queueState.queueCounts.running}/
              {queueState.queueCounts.failed}
            </div>
            <div className="text-[9px] text-muted-foreground">
              Completed: {queueState.queueCounts.succeeded}
            </div>
          </div>
          <div className="space-y-0.5">
            <div className="flex items-center justify-between text-[9px] text-muted-foreground">
              <span>Jobs/min</span>
              <Sparkline
                ariaLabel="Queue throughput trend"
                className="text-emerald-500 dark:text-emerald-400"
                height={16}
                values={throughputTrend}
                width={56}
              />
            </div>
            <div className="font-medium text-[11px]">{formatPerMinute(queueState.throughput)}</div>
            <div className="flex items-center justify-between text-[9px] text-muted-foreground">
              <span>Errors (1m): {queueState.recentErrorCount}</span>
              <Sparkline
                ariaLabel="Queue error trend"
                className="text-destructive"
                height={12}
                values={errorTrend}
                width={56}
              />
            </div>
          </div>
          <div className="space-y-0.5">
            <div className="flex items-center justify-between text-[9px] text-muted-foreground">
              <span>Latency (ms)</span>
              <Sparkline
                ariaLabel="Queue latency trend"
                className="text-sky-500 dark:text-sky-400"
                height={12}
                values={latencyTrend}
                width={56}
              />
            </div>
            <div className="font-medium text-[11px]">
              P50 {formatLatencyMs(queueState.latencyStats.p50Ms)}
            </div>
            <div className="text-[9px] text-muted-foreground">
              Avg {formatLatencyMs(queueState.latencyStats.avgMs)} · P95{' '}
              {formatLatencyMs(queueState.latencyStats.p95Ms)}
            </div>
          </div>
        </div>
        {(workerControls.startWorkerError || queueState.lastError) && (
          <div
            aria-live="polite"
            className="break-words rounded border border-destructive/20 bg-destructive/10 p-1 text-[10px] text-destructive"
            role="alert"
          >
            {workerControls.startWorkerError ?? queueState.lastError}
          </div>
        )}
      </CardContent>
    </Card>
  );

  return content;
}

// Safe, hook-less variant for contexts without DbProvider (e.g., shallow tests)
export function VectorStatus() {
  const device = useMemo(() => TransformersBackend.getBestDevice(), []);
  return (
    <Card>
      <CardHeader className="border-b px-3 py-1.5">
        <div className="flex items-center justify-between">
          <CardTitle className="font-medium text-xs">Vector Status</CardTitle>
          <div className="flex items-center gap-1">
            <Badge className="h-4 px-1 py-0 text-[9px]" variant={'outline'}>
              pgvector: off
            </Badge>
            <Badge className="h-4 px-1 py-0 text-[9px]" variant={'secondary'}>
              worker: disabled
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <Label className="font-medium text-[9px] text-muted-foreground uppercase tracking-wider">
            Device:
          </Label>
          <Badge className="px-1.5 py-0.5 text-[10px]" variant="outline">
            {device}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
