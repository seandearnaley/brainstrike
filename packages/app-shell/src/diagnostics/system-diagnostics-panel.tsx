import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import {
  type BoundaryTransport,
  callBoundary,
} from '@brainstrike/assistant-contract/boundary-result';
/**
 * System Diagnostics Panel (BST-181)
 *
 * Unified diagnostics view that aggregates:
 * - Database connection status
 * - Queue health metrics (durable + ephemeral)
 * - Worker health status
 *
 * Provides a centralized location for monitoring system health
 * without navigating to multiple places.
 */

import {
  databaseStatusSelectors,
  useDatabaseStatusStore,
} from '@brainstrike/app-state/stores/database-status-store';
import { type DatabaseQueryTelemetrySnapshot, databaseQueryTelemetry } from '@brainstrike/db';
import {
  assertEmbeddingTelemetrySnapshot,
  createEmptyEmbeddingTelemetrySnapshot,
  type EmbeddingTelemetrySnapshot,
  getEmbeddingTelemetrySnapshot,
  subscribeEmbeddingTelemetryThrottled,
} from '@brainstrike/embeddings';
import { type IndexerTelemetrySnapshot, useIndexerTelemetry } from '@brainstrike/token-cache';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@brainstrike/ui';
import { Activity, CheckCircle2, Database, RefreshCw, Server, Timer, XCircle } from 'lucide-react';
import {
  lazy,
  type ReactElement,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type RendererLongTaskTelemetrySnapshot,
  rendererLongTaskTelemetry,
} from './renderer-long-task-telemetry';

/** Animation duration in ms for refresh button visual feedback */
const REFRESH_ANIMATION_DURATION_MS = 500;
const EMPTY_EMBEDDING_TELEMETRY = createEmptyEmbeddingTelemetrySnapshot();
const EMBEDDING_TELEMETRY_PROVIDER_ERROR_MESSAGE =
  'Embedding telemetry provider failed. See internal diagnostics for details.';
const LazyQueueDiagnosticsPanel = lazy(async () => {
  const module = await import('@brainstrike/vector-management');
  return { default: module.QueueDiagnosticsPanel };
});

type StatusVariant = 'success' | 'warning' | 'error' | 'loading' | 'neutral';
const STATUS_BADGE_VARIANTS: Record<StatusVariant, 'default' | 'secondary' | 'destructive'> = {
  error: 'destructive',
  loading: 'secondary',
  neutral: 'secondary',
  success: 'default',
  warning: 'secondary',
};

type RuntimeHostPlatformState =
  | 'active'
  | 'disposed'
  | 'failed'
  | 'idle'
  | 'ready'
  | 'resetting'
  | 'restarting'
  | 'starting'
  | 'stopped'
  | 'stopping';

interface RuntimeHostPlatformStatus {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly pendingRequestCount: number;
  readonly runtimeId: string;
  readonly runtimeKind: 'embedding-host' | 'llm-host';
  readonly sourceState: string;
  readonly state: RuntimeHostPlatformState;
}

type DimensionIndexMaintenanceState = 'failed' | 'pending' | 'running' | 'succeeded';

interface DimensionIndexMaintenanceRow {
  readonly dimension: number;
  readonly lastError: string | null;
  readonly reason: string;
  readonly state: DimensionIndexMaintenanceState;
  readonly strategy: 'concurrent' | 'regular';
}

interface DimensionIndexSuspensionRow {
  readonly dimension: number;
  readonly reason: string;
  readonly suspendedAt: string;
}

interface DesktopPlatformDiagnosticsSnapshot {
  readonly collectedAt: string;
  readonly crashRecovery?: {
    readonly lastRendererCrashReason: string | null;
    readonly pendingRendererRecovery: boolean;
    readonly rendererCrashCount: number;
    readonly rendererReloadAttemptCount: number;
    readonly suppressedRendererReloadCount: number;
  };
  readonly embeddingHost: RuntimeHostPlatformStatus;
  readonly errors?: {
    readonly embeddingTelemetry?: string;
  };
  readonly indexing?: {
    readonly activeBackfills: readonly unknown[];
    readonly databaseWork: unknown;
    readonly dimensionIndexMaintenance?: {
      readonly maintenance: readonly DimensionIndexMaintenanceRow[];
      readonly suspensions: readonly DimensionIndexSuspensionRow[];
    };
  };
  readonly llmHost: RuntimeHostPlatformStatus;
  readonly migration?: {
    readonly attemptCount: number | null;
    readonly inFlight: boolean | null;
    readonly lastFailure: unknown;
    readonly lastSucceededAt: string | null;
  };
  readonly reset: {
    readonly status?: string;
    readonly userDataPath: string;
  };
  readonly telemetry?: {
    readonly backgroundRuntimeMetrics: readonly unknown[];
    readonly embedding?: EmbeddingTelemetrySnapshot;
  };
}

interface DesktopDiagnosticsBridge {
  readonly getSnapshot: () => Promise<DesktopPlatformDiagnosticsSnapshot>;
}

interface EmbeddingHostStatusSubscriptionBridge {
  readonly onStatus: (callback: (status: unknown) => void) => () => void;
}

function getDesktopDiagnosticsBridge(): DesktopDiagnosticsBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const candidate = (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics;
  if (
    candidate &&
    typeof candidate === 'object' &&
    'getSnapshot' in candidate &&
    typeof candidate.getSnapshot === 'function'
  ) {
    const transport = candidate as BoundaryTransport<DesktopDiagnosticsBridge>;
    return { getSnapshot: () => callBoundary(() => transport.getSnapshot()) };
  }
  return null;
}

function getEmbeddingHostStatusSubscriptionBridge(): EmbeddingHostStatusSubscriptionBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const candidate = (window as Window & { embeddingHost?: unknown }).embeddingHost;
  if (
    candidate &&
    typeof candidate === 'object' &&
    'onStatus' in candidate &&
    typeof candidate.onStatus === 'function'
  ) {
    return candidate as EmbeddingHostStatusSubscriptionBridge;
  }
  return null;
}

function readEmbeddingTelemetryFromHostStatus(status: unknown): EmbeddingTelemetrySnapshot | null {
  if (!(status && typeof status === 'object' && !Array.isArray(status))) {
    throw new Error('Embedding host status must be an object.');
  }
  const statusRecord = status as Record<string, unknown>;
  const embeddingRuntime = statusRecord['embeddingRuntime'];
  if (embeddingRuntime === undefined) {
    const state = statusRecord['state'];
    if (state === 'error' || state === 'stopped') {
      return EMPTY_EMBEDDING_TELEMETRY;
    }
    if (state === 'running' || state === 'starting' || state === 'stopping') {
      return null;
    }
    throw new Error('Embedding host status state is invalid.');
  }
  if (
    !(embeddingRuntime && typeof embeddingRuntime === 'object' && !Array.isArray(embeddingRuntime))
  ) {
    throw new Error('Embedding host status embeddingRuntime must be an object.');
  }
  return assertEmbeddingTelemetrySnapshot(
    (embeddingRuntime as Record<string, unknown>)['telemetry']
  );
}

interface StatusBadgeProps {
  readonly label: string;
  readonly status: StatusVariant;
}

function StatusBadge({ status, label }: StatusBadgeProps): ReactElement {
  return (
    <Badge
      className="h-5 px-2 text-[10px]"
      data-status={status}
      variant={STATUS_BADGE_VARIANTS[status]}
    >
      {label}
    </Badge>
  );
}

interface DiagnosticCardProps {
  readonly children?: ReactElement;
  readonly description?: string;
  readonly icon: ReactElement;
  readonly status: StatusVariant;
  readonly statusLabel: string;
  readonly title: string;
}

function DiagnosticCard({
  title,
  description,
  icon,
  status,
  statusLabel,
  children,
}: DiagnosticCardProps): ReactElement {
  return (
    <Card>
      <CardHeader className="border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon}
            <div>
              <CardTitle className="text-sm">{title}</CardTitle>
              {description && (
                <CardDescription className="text-[10px]">{description}</CardDescription>
              )}
            </div>
          </div>
          <StatusBadge label={statusLabel} status={status} />
        </div>
      </CardHeader>
      {children && <CardContent className="p-4">{children}</CardContent>}
    </Card>
  );
}

/**
 * Database status section showing connection state and location.
 */
function DatabaseStatusSection(): ReactElement {
  const connected = useDatabaseStatusStore(databaseStatusSelectors.isConnected);
  const loading = useDatabaseStatusStore(databaseStatusSelectors.isLoading);
  const location = useDatabaseStatusStore(databaseStatusSelectors.location);
  const testResult = useDatabaseStatusStore(databaseStatusSelectors.testResult);

  const getStatus = (): { variant: StatusVariant; label: string } => {
    if (loading) {
      return { label: 'Connecting...', variant: 'loading' };
    }
    if (connected) {
      return { label: 'Connected', variant: 'success' };
    }
    return { label: 'Disconnected', variant: 'error' };
  };

  const { variant, label } = getStatus();
  const displayLocation =
    location === 'Main Process' ? 'IPC (Main Process)' : (location ?? 'Unknown');

  return (
    <DiagnosticCard
      description="PGlite database connection"
      icon={<Database className="h-4 w-4 text-primary" />}
      status={variant}
      statusLabel={label}
      title="Database"
    >
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Location</span>
          <span className="font-medium">{displayLocation}</span>
        </div>
        {testResult && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Test Result</span>
            <span className="font-mono text-[10px]">{testResult}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 pt-1">
          {connected ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-destructive" />
          )}
          <span className="text-[10px] text-muted-foreground">
            {connected ? 'Database is operational' : 'Database connection failed'}
          </span>
        </div>
      </div>
    </DiagnosticCard>
  );
}

/**
 * Worker health section with status indicators.
 */
interface WorkerStatusSectionProps {
  readonly persistenceMode?: 'persistent' | 'memory' | 'disabled' | undefined;
  readonly tokenCacheOperational?: boolean | undefined;
  readonly tokenCachePersisted?: boolean | undefined;
}

function WorkerStatusSection({
  tokenCacheOperational = false,
  tokenCachePersisted = false,
  persistenceMode = 'disabled',
}: WorkerStatusSectionProps): ReactElement {
  const getStatus = (): { variant: StatusVariant; label: string } => {
    if (!tokenCacheOperational) {
      return { label: 'Not Ready', variant: 'error' };
    }
    if (tokenCachePersisted) {
      return { label: 'Fully Operational', variant: 'success' };
    }
    return { label: 'Memory Only', variant: 'warning' };
  };

  const { variant, label } = getStatus();

  const modeDescriptions: Record<'persistent' | 'memory' | 'disabled', string> = {
    disabled: 'Token counting worker is not running',
    memory: 'Token counts are in-memory only (no persistence)',
    persistent: 'Token counts are saved to database',
  };

  return (
    <DiagnosticCard
      description="Token counting and indexing worker"
      icon={<Server className="h-4 w-4 text-primary" />}
      status={variant}
      statusLabel={label}
      title="Token Cache Worker"
    >
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Operational</span>
          <span className="font-medium">{tokenCacheOperational ? 'Yes' : 'No'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Persisted</span>
          <span className="font-medium">{tokenCachePersisted ? 'Yes' : 'No'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Mode</span>
          <Badge className="h-4 px-1.5 text-[9px]" variant="secondary">
            {persistenceMode}
          </Badge>
        </div>
        <div className="pt-1 text-[10px] text-muted-foreground">
          {modeDescriptions[persistenceMode]}
        </div>
      </div>
    </DiagnosticCard>
  );
}

const DATABASE_QUERY_FEATURE_LABELS = {
  'file-tree': 'File tree',
  'live-query': 'Live queries',
  'queue-stats': 'Queue stats',
  'token-estimation': 'Token estimation',
} as const;

function DatabaseQueryTelemetrySection({
  snapshot,
}: {
  readonly snapshot: DatabaseQueryTelemetrySnapshot;
}): ReactElement {
  const failures = Object.values(snapshot.features).reduce(
    (total, feature) => total + feature.failureCount,
    0
  );
  const totalQueries = Object.values(snapshot.features).reduce(
    (total, feature) => total + feature.queryCount,
    0
  );
  const cacheHitLabel =
    snapshot.tokenEstimation.cacheHitRate === null
      ? 'No lookups'
      : `${Math.round(snapshot.tokenEstimation.cacheHitRate * 100)}% cache hit`;

  return (
    <DiagnosticCard
      description="Rolling one-minute coarse query histograms"
      icon={<Database className="h-4 w-4 text-primary" />}
      status={snapshot.availability === 'failed' ? 'error' : failures > 0 ? 'warning' : 'success'}
      statusLabel={formatCount(totalQueries, 'query', 'queries')}
      title="Database Queries"
    >
      <div className="space-y-2 text-xs">
        {Object.entries(DATABASE_QUERY_FEATURE_LABELS).map(([feature, label]) => {
          const metrics = snapshot.features[feature as keyof typeof snapshot.features];
          return (
            <div className="space-y-0.5" key={feature}>
              <span className="text-muted-foreground">{label}</span>
              <div
                className="font-mono text-[10px]"
                data-testid={`database-query-${feature}-metrics`}
              >
                {metrics.queryCount} queries · {metrics.failureCount} failed · p50{' '}
                {Math.round(metrics.durationP50Ms)} ms · p95 {Math.round(metrics.durationP95Ms)} ms
                · max {Math.round(metrics.maxDurationMs)} ms
                {' · '}
                {metrics.droppedSampleCount} dropped
              </div>
            </div>
          );
        })}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Token cache</span>
          <span className="font-medium">{cacheHitLabel}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Live subscriptions</span>
          <span className="font-medium">
            {formatCount(snapshot.activeLiveSubscriptions, 'active', 'active')}
          </span>
        </div>
        {snapshot.droppedSampleCount > 0 ? (
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Retention overflow</span>
            <span>{formatCount(snapshot.droppedSampleCount, 'sample', 'samples')} dropped</span>
          </div>
        ) : null}
        {snapshot.availability === 'failed' ? (
          <div className="text-destructive" role="alert">
            Query telemetry unavailable: {snapshot.unavailableReason}
          </div>
        ) : null}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Live updates</span>
          <span className="font-mono text-[10px]" data-testid="database-live-update-metrics">
            {formatCount(snapshot.liveUpdateCount, 'update', 'updates')}
          </span>
        </div>
      </div>
    </DiagnosticCard>
  );
}

function getHostStatusVariant(state: RuntimeHostPlatformState): StatusVariant {
  if (state === 'active' || state === 'idle' || state === 'ready') {
    return 'success';
  }
  if (state === 'failed' || state === 'disposed') {
    return 'error';
  }
  return 'warning';
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatBinaryBytes(bytes: number): string {
  const units = [
    { bytes: 1024 ** 3, label: 'GiB' },
    { bytes: 1024 ** 2, label: 'MiB' },
    { bytes: 1024, label: 'KiB' },
  ] as const;
  for (const unit of units) {
    if (bytes >= unit.bytes) {
      const scaled = bytes / unit.bytes;
      return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)} ${unit.label}`;
    }
  }
  return `${bytes} B`;
}

type TokenIndexerDiagnosticsSnapshot = Pick<
  IndexerTelemetrySnapshot,
  | 'averageLatencyMs'
  | 'cacheHitRate'
  | 'errorCount'
  | 'latencyP50Ms'
  | 'latencyP95Ms'
  | 'totalFilesPerMinute'
  | 'totalTokensIndexed'
> & {
  readonly eventCount: number;
};

function formatLatency(latencyMs: number | null): string {
  return latencyMs === null ? '—' : `${Math.round(latencyMs)} ms`;
}

function TokenIndexerTelemetrySection({
  snapshot,
}: {
  readonly snapshot: TokenIndexerDiagnosticsSnapshot;
}): ReactElement {
  const hasSamples = snapshot.eventCount > 0;
  const status = snapshot.errorCount > 0 ? 'warning' : hasSamples ? 'success' : 'loading';
  const statusLabel =
    snapshot.errorCount > 0
      ? formatCount(snapshot.errorCount, 'error', 'errors')
      : hasSamples
        ? formatCount(snapshot.eventCount, 'sample', 'samples')
        : 'No samples';
  const cacheHitRate =
    snapshot.cacheHitRate === null ? 'No samples' : `${Math.round(snapshot.cacheHitRate * 100)}%`;

  return (
    <DiagnosticCard
      description="Background file-token indexing, rolling one-minute window"
      icon={<Timer className="h-4 w-4 text-primary" />}
      status={status}
      statusLabel={statusLabel}
      title="Token Indexing"
    >
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Latency</span>
          <span className="font-mono text-[10px]" data-testid="token-indexer-latency">
            avg {formatLatency(snapshot.averageLatencyMs)} · p50{' '}
            {formatLatency(snapshot.latencyP50Ms)} · p95 {formatLatency(snapshot.latencyP95Ms)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Cache hit rate</span>
          <span className="font-medium" data-testid="token-indexer-cache-hit-rate">
            {cacheHitRate}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Throughput</span>
          <span className="font-medium" data-testid="token-indexer-throughput">
            {formatCount(Math.round(snapshot.totalFilesPerMinute), 'file', 'files')}/min
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Indexed tokens</span>
          <span className="font-medium">
            {formatCount(snapshot.totalTokensIndexed, 'token', 'tokens')}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Errors</span>
          <span className="font-medium" data-testid="token-indexer-error-count">
            {formatCount(snapshot.errorCount, 'error', 'errors')}
          </span>
        </div>
      </div>
    </DiagnosticCard>
  );
}

function EmbeddingRuntimeDiagnosticsCard({
  providerError,
  telemetry,
}: {
  readonly providerError: string | null;
  readonly telemetry: EmbeddingTelemetrySnapshot;
}): ReactElement {
  const hasSamples = telemetry.lastUpdatedAt !== null;
  const hasFailures = providerError !== null || telemetry.health.failureCount > 0;
  const residentDeviceCounts = telemetry.cache.entries.reduce(
    (counts, entry) => {
      counts[entry.device] += 1;
      return counts;
    },
    { wasm: 0, webgpu: 0 }
  );
  return (
    <DiagnosticCard
      description="Worker transfer and model residency"
      icon={<Activity className="h-4 w-4 text-primary" />}
      status={hasFailures ? 'error' : hasSamples ? 'success' : 'neutral'}
      statusLabel={
        providerError
          ? 'Embedding telemetry unavailable'
          : hasFailures
            ? 'Telemetry degraded'
            : hasSamples
              ? 'Observed'
              : 'No samples'
      }
      title="Embedding Runtime"
    >
      <div className="space-y-2 text-xs">
        {providerError ? (
          <div className="text-destructive" role="alert">
            {EMBEDDING_TELEMETRY_PROVIDER_ERROR_MESSAGE}
          </div>
        ) : null}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Pipeline Cache</span>
          <span className="font-medium">
            {formatCount(telemetry.cache.residentCount, 'resident', 'resident')}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Batch Transfer</span>
          <span className="font-mono text-[10px]">
            {formatBinaryBytes(telemetry.batchTransfer.totalBytes)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Estimated GPU</span>
          <span className="font-mono text-[10px]">
            {formatBinaryBytes(telemetry.cache.estimatedGpuBytes)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Estimated Heap</span>
          <span className="font-mono text-[10px]">
            {formatBinaryBytes(telemetry.cache.estimatedHeapBytes)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Peak In Flight</span>
          <span className="font-medium">
            {formatCount(telemetry.peakVectorsInFlight, 'vector', 'vectors')}
          </span>
        </div>
        {telemetry.cache.entries.length > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Resident Devices</span>
            <span className="font-mono text-[10px]">
              {`${residentDeviceCounts.webgpu} WebGPU · ${residentDeviceCounts.wasm} WASM`}
            </span>
          </div>
        )}
        {telemetry.cache.memoryEstimateUnavailableCount > 0 && (
          <div className="text-[10px] text-warning">
            {formatCount(
              telemetry.cache.memoryEstimateUnavailableCount,
              'model estimate unavailable',
              'model estimates unavailable'
            )}
          </div>
        )}
        {telemetry.health.failureCount > 0 && (
          <div className="text-[10px] text-destructive">
            {formatCount(telemetry.health.failureCount, 'telemetry failure', 'telemetry failures')}
          </div>
        )}
      </div>
    </DiagnosticCard>
  );
}

function getMigrationLabel(snapshot: DesktopPlatformDiagnosticsSnapshot): string {
  const migration = snapshot.migration;
  if (!migration) {
    return 'unavailable';
  }
  if (migration.inFlight) {
    return 'running';
  }
  if (migration.lastFailure) {
    return 'failed';
  }
  return formatCount(migration.attemptCount ?? 0, 'attempt', 'attempts');
}

function getCrashRecoveryLabel(snapshot: DesktopPlatformDiagnosticsSnapshot): string {
  const crashRecovery = snapshot.crashRecovery;
  if (!crashRecovery) {
    return 'unavailable';
  }
  if (crashRecovery.pendingRendererRecovery) {
    return 'pending';
  }
  if (crashRecovery.suppressedRendererReloadCount > 0) {
    return 'suppressed';
  }
  return formatCount(crashRecovery.rendererReloadAttemptCount, 'reload', 'reloads');
}

function getDimensionMaintenanceLabel(snapshot: DesktopPlatformDiagnosticsSnapshot): string {
  const dimensionIndexMaintenance = snapshot.indexing?.dimensionIndexMaintenance;
  if (!dimensionIndexMaintenance) {
    return 'unavailable';
  }
  const pending = dimensionIndexMaintenance.maintenance.filter(
    (row) => row.state === 'pending'
  ).length;
  const running = dimensionIndexMaintenance.maintenance.filter(
    (row) => row.state === 'running'
  ).length;
  const failed = dimensionIndexMaintenance.maintenance.filter(
    (row) => row.state === 'failed'
  ).length;
  const suspended = dimensionIndexMaintenance.suspensions.length;
  const active = pending + running + failed + suspended;
  if (active === 0) {
    return 'idle';
  }
  const labels: string[] = [];
  if (failed > 0) {
    labels.push(formatCount(failed, 'failed', 'failed'));
  }
  if (running > 0) {
    labels.push(formatCount(running, 'running', 'running'));
  }
  if (pending > 0) {
    labels.push(formatCount(pending, 'pending', 'pending'));
  }
  if (suspended > 0) {
    labels.push(formatCount(suspended, 'suspended', 'suspended'));
  }
  return labels.join(' / ');
}

function DesktopPlatformStatusSection({
  snapshot,
}: {
  readonly snapshot: DesktopPlatformDiagnosticsSnapshot;
}): ReactElement {
  const embeddingVariant = getHostStatusVariant(snapshot.embeddingHost.state);
  const llmVariant = getHostStatusVariant(snapshot.llmHost.state);
  const status: StatusVariant =
    embeddingVariant === 'error' || llmVariant === 'error'
      ? 'error'
      : embeddingVariant === 'warning' || llmVariant === 'warning'
        ? 'warning'
        : 'success';

  return (
    <DiagnosticCard
      description="Hidden desktop runtime hosts"
      icon={<Server className="h-4 w-4 text-primary" />}
      status={status}
      statusLabel={status === 'success' ? 'Ready' : status === 'warning' ? 'Transition' : 'Issue'}
      title="Desktop Platform"
    >
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Embedding Host</span>
          <span className="font-medium">{snapshot.embeddingHost.state}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">LLM Host</span>
          <span className="font-medium">{snapshot.llmHost.state}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Pending Requests</span>
          <span className="font-mono text-[10px]">
            {snapshot.embeddingHost.pendingRequestCount + snapshot.llmHost.pendingRequestCount}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Active Backfills</span>
          <span className="font-medium">
            {formatCount(snapshot.indexing?.activeBackfills.length ?? 0, 'active', 'active')}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Dimension Maintenance</span>
          <span className="font-medium">{getDimensionMaintenanceLabel(snapshot)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Migration</span>
          <span className="font-medium">{getMigrationLabel(snapshot)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Crash Recovery</span>
          <span className="font-medium">{getCrashRecoveryLabel(snapshot)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Runtime Metrics</span>
          <span className="font-medium">
            {formatCount(
              snapshot.telemetry?.backgroundRuntimeMetrics.length ?? 0,
              'process',
              'processes'
            )}
          </span>
        </div>
        {snapshot.reset.status && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Reset</span>
            <span className="font-medium">{snapshot.reset.status}</span>
          </div>
        )}
        <div className="truncate pt-1 text-[10px] text-muted-foreground">
          {snapshot.reset.userDataPath}
        </div>
      </div>
    </DiagnosticCard>
  );
}

function formatDuration(durationMs: number | null): string {
  return durationMs === null ? 'No samples' : `${Math.round(durationMs)} ms`;
}

function formatRendererLongTaskStatus(snapshot: RendererLongTaskTelemetrySnapshot): string {
  if (snapshot.availability === 'active') {
    return formatCount(snapshot.sampleCount, 'sample', 'samples');
  }
  if (snapshot.availability === 'failed') {
    return `Failed · ${formatCount(snapshot.sampleCount, 'sample', 'samples')}`;
  }
  if (snapshot.availability === 'unsupported') {
    return 'Unsupported';
  }
  return `Idle · ${formatCount(snapshot.sampleCount, 'sample', 'samples')}`;
}

function formatRendererLongTaskFeatureFlags(snapshot: RendererLongTaskTelemetrySnapshot): string {
  if (snapshot.featureFlagContextAvailability === 'unavailable') {
    return snapshot.sampleCount === 0
      ? 'No feature flag source'
      : 'Unavailable for retained samples';
  }
  if (snapshot.sampleCount === 0) {
    return 'No samples';
  }
  const knownFlags = snapshot.featureFlags
    .map((featureFlag) => `${featureFlag.flag} (${featureFlag.count})`)
    .join(', ');
  if (snapshot.featureFlagContextAvailability === 'mixed') {
    const denominator = `${snapshot.featureFlagContextSampleCount} of ${snapshot.sampleCount} samples`;
    return knownFlags.length > 0
      ? `${knownFlags} · partial context, ${denominator}`
      : `Partial feature flag context, ${denominator}`;
  }
  return knownFlags.length > 0 ? knownFlags : 'None active';
}

function RendererLongTaskStatusSection({
  snapshot,
}: {
  readonly snapshot: RendererLongTaskTelemetrySnapshot;
}): ReactElement {
  const status: StatusVariant =
    snapshot.availability === 'failed'
      ? 'error'
      : snapshot.availability === 'unsupported' || snapshot.availability === 'idle'
        ? 'warning'
        : 'success';
  const statusLabel = formatRendererLongTaskStatus(snapshot);

  return (
    <DiagnosticCard
      description="Main-thread stalls in the rolling one-minute window"
      icon={<Timer className="h-4 w-4 text-primary" />}
      status={status}
      statusLabel={statusLabel}
      title="Renderer Long Tasks"
    >
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">P50</span>
          <span className="font-mono text-[10px]">{formatDuration(snapshot.durationP50Ms)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">P95</span>
          <span className="font-mono text-[10px]">{formatDuration(snapshot.durationP95Ms)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Maximum</span>
          <span className="font-mono text-[10px]">{formatDuration(snapshot.maxDurationMs)}</span>
        </div>
        {snapshot.routes.length > 0 && (
          <div className="flex items-start justify-between gap-3">
            <span className="text-muted-foreground">Delivery-time routes</span>
            <span className="text-right font-mono text-[10px]">
              {snapshot.routes.map((route) => `${route.route} (${route.count})`).join(', ')}
            </span>
          </div>
        )}
        <div className="flex items-start justify-between gap-3">
          <span className="text-muted-foreground">Delivery-time feature flags</span>
          <span className="text-right font-mono text-[10px]">
            {formatRendererLongTaskFeatureFlags(snapshot)}
          </span>
        </div>
        {snapshot.unavailableReason && (
          <div className="pt-1 text-[10px] text-muted-foreground">{snapshot.unavailableReason}</div>
        )}
      </div>
    </DiagnosticCard>
  );
}

export interface SystemDiagnosticsPanelProps {
  /** Token cache persistence mode (from TokenCacheContext) */
  readonly persistenceMode?: 'persistent' | 'memory' | 'disabled' | undefined;
  /** Show refresh button for queue metrics */
  readonly showQueueRefresh?: boolean | undefined;
  /** Token cache operational status (from TokenCacheContext) */
  readonly tokenCacheOperational?: boolean | undefined;
  /** Token cache persistence status (from TokenCacheContext) */
  readonly tokenCachePersisted?: boolean | undefined;
}

/**
 * Unified system diagnostics panel.
 *
 * Displays database status, queue health, and worker status
 * in a single consolidated view for easy monitoring.
 */
export function SystemDiagnosticsPanel({
  tokenCacheOperational,
  tokenCachePersisted,
  persistenceMode,
  showQueueRefresh = true,
}: SystemDiagnosticsPanelProps): ReactElement {
  const [desktopSnapshot, setDesktopSnapshot] = useState<DesktopPlatformDiagnosticsSnapshot | null>(
    null
  );
  const [desktopEmbeddingTelemetry, setDesktopEmbeddingTelemetry] =
    useState<EmbeddingTelemetrySnapshot | null>(null);
  const [desktopDiagnosticsError, setDesktopDiagnosticsError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localEmbeddingTelemetry = useSyncExternalStore(
    subscribeEmbeddingTelemetryThrottled,
    getEmbeddingTelemetrySnapshot,
    () => EMPTY_EMBEDDING_TELEMETRY
  );
  const embeddingTelemetry =
    desktopEmbeddingTelemetry ?? desktopSnapshot?.telemetry?.embedding ?? localEmbeddingTelemetry;
  const embeddingTelemetryProviderError =
    desktopEmbeddingTelemetry === null
      ? (desktopSnapshot?.errors?.embeddingTelemetry ?? null)
      : null;
  const databaseQuerySnapshot = useSyncExternalStore(
    databaseQueryTelemetry.subscribe,
    databaseQueryTelemetry.getSnapshot,
    databaseQueryTelemetry.getSnapshot
  );
  const { snapshot: tokenIndexerTelemetry } = useIndexerTelemetry();
  const tokenIndexerDiagnostics: TokenIndexerDiagnosticsSnapshot = {
    averageLatencyMs: tokenIndexerTelemetry.averageLatencyMs,
    cacheHitRate: tokenIndexerTelemetry.cacheHitRate,
    errorCount: tokenIndexerTelemetry.errorCount,
    eventCount: tokenIndexerTelemetry.events.length,
    latencyP50Ms: tokenIndexerTelemetry.latencyP50Ms,
    latencyP95Ms: tokenIndexerTelemetry.latencyP95Ms,
    totalFilesPerMinute: tokenIndexerTelemetry.totalFilesPerMinute,
    totalTokensIndexed: tokenIndexerTelemetry.totalTokensIndexed,
  };
  const longTaskSnapshot = useSyncExternalStore(
    rendererLongTaskTelemetry.subscribe,
    rendererLongTaskTelemetry.getSnapshot,
    rendererLongTaskTelemetry.getSnapshot
  );

  // Cleanup timeout on unmount to prevent memory leaks
  useEffect(() => {
    const ref = refreshTimeoutRef;
    return () => {
      if (ref.current) {
        clearTimeout(ref.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const bridge = getDesktopDiagnosticsBridge();
    if (!bridge) {
      setDesktopSnapshot(null);
      setDesktopEmbeddingTelemetry(null);
      setDesktopDiagnosticsError(null);
      return () => {
        cancelled = true;
      };
    }
    const hostStatusBridge = getEmbeddingHostStatusSubscriptionBridge();
    if (!hostStatusBridge) {
      setDesktopSnapshot(null);
      setDesktopDiagnosticsError('Desktop embedding host status bridge is unavailable.');
      return () => {
        cancelled = true;
      };
    }
    setDesktopEmbeddingTelemetry(null);
    const unsubscribe = hostStatusBridge.onStatus((status) => {
      if (cancelled) {
        return;
      }
      try {
        const telemetry = readEmbeddingTelemetryFromHostStatus(status);
        if (telemetry) {
          setDesktopEmbeddingTelemetry(telemetry);
          setDesktopDiagnosticsError((currentError) =>
            currentError?.startsWith('Embedding host status telemetry is invalid:')
              ? null
              : currentError
          );
        }
      } catch (error) {
        setDesktopDiagnosticsError(
          `Embedding host status telemetry is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
    void bridge.getSnapshot().then(
      (snapshot) => {
        if (!cancelled) {
          try {
            if (snapshot.telemetry?.embedding !== undefined) {
              assertEmbeddingTelemetrySnapshot(snapshot.telemetry.embedding);
            }
            setDesktopSnapshot(snapshot);
            setDesktopDiagnosticsError((currentError) =>
              currentError?.startsWith('Embedding host status telemetry is invalid:')
                ? currentError
                : null
            );
          } catch (error) {
            setDesktopSnapshot(null);
            setDesktopDiagnosticsError(
              `Desktop embedding telemetry is invalid: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setDesktopSnapshot(null);
          setDesktopDiagnosticsError(describeBoundaryError(error));
        }
      }
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [refreshKey]);

  const handleRefreshAll = useCallback(() => {
    setIsRefreshing(true);
    setRefreshKey((k) => k + 1);
    // Clear any existing timeout before setting a new one
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }
    // Brief timeout to show refresh animation
    refreshTimeoutRef.current = setTimeout(
      () => setIsRefreshing(false),
      REFRESH_ANIMATION_DURATION_MS
    );
  }, []);

  return (
    <div className="space-y-6" data-testid="system-diagnostics-panel">
      {/* Header with refresh button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          <div>
            <h3 className="font-semibold text-lg">System Diagnostics</h3>
            <p className="text-muted-foreground text-xs">
              Real-time health monitoring for database, queues, and workers
            </p>
          </div>
        </div>
        <button
          aria-label="Refresh all diagnostics"
          className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          data-testid="system-diagnostics-refresh"
          disabled={isRefreshing}
          onClick={handleRefreshAll}
          type="button"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          Refresh All
        </button>
      </div>

      {/* Diagnostic sections grid */}
      <div className="grid gap-4 md:grid-cols-2">
        <DatabaseStatusSection />
        <WorkerStatusSection
          persistenceMode={persistenceMode}
          tokenCacheOperational={tokenCacheOperational}
          tokenCachePersisted={tokenCachePersisted}
        />
        <DatabaseQueryTelemetrySection snapshot={databaseQuerySnapshot} />
        <TokenIndexerTelemetrySection snapshot={tokenIndexerDiagnostics} />
        <RendererLongTaskStatusSection snapshot={longTaskSnapshot} />
        {desktopSnapshot && <DesktopPlatformStatusSection snapshot={desktopSnapshot} />}
        <EmbeddingRuntimeDiagnosticsCard
          providerError={embeddingTelemetryProviderError}
          telemetry={embeddingTelemetry}
        />
        {desktopDiagnosticsError && (
          <DiagnosticCard
            description="Hidden desktop runtime hosts"
            icon={<Server className="h-4 w-4 text-primary" />}
            status="error"
            statusLabel="Issue"
            title="Desktop Platform"
          >
            <div className="text-destructive text-xs">{desktopDiagnosticsError}</div>
          </DiagnosticCard>
        )}
      </div>

      {/* Queue diagnostics - full width */}
      <div key={refreshKey}>
        <Suspense fallback={null}>
          <LazyQueueDiagnosticsPanel showRefresh={showQueueRefresh} />
        </Suspense>
      </div>
    </div>
  );
}
