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
 * - Worker health status
 *
 * Provides a centralized location for monitoring system health
 * without navigating to multiple places.
 */

import {
  databaseStatusSelectors,
  useDatabaseStatusStore,
} from '@brainstrike/app-state/stores/database-status-store';
import { type IndexerTelemetrySnapshot, useIndexerTelemetry } from '@brainstrike/token-cache';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@brainstrike/ui';
import { Activity, CheckCircle2, Database, RefreshCw, Server, Timer, XCircle } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  type RendererLongTaskTelemetrySnapshot,
  rendererLongTaskTelemetry,
} from './renderer-long-task-telemetry';

/** Animation duration in ms for refresh button visual feedback */
const REFRESH_ANIMATION_DURATION_MS = 500;

type StatusVariant = 'success' | 'warning' | 'error' | 'loading' | 'neutral';
const STATUS_BADGE_VARIANTS: Record<StatusVariant, 'default' | 'secondary' | 'destructive'> = {
  error: 'destructive',
  loading: 'secondary',
  neutral: 'secondary',
  success: 'default',
  warning: 'secondary',
};

interface DesktopPlatformDiagnosticsSnapshot {
  readonly collectedAt: string;
  readonly crashRecovery?: {
    readonly lastRendererCrashReason: string | null;
    readonly pendingRendererRecovery: boolean;
    readonly rendererCrashCount: number;
    readonly rendererReloadAttemptCount: number;
    readonly suppressedRendererReloadCount: number;
  };
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
}

interface DesktopDiagnosticsBridge {
  readonly getSnapshot: () => Promise<DesktopPlatformDiagnosticsSnapshot>;
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
      return { label: 'Connecting…', variant: 'loading' };
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
      description="Local SQLite database"
      icon={<Database className="text-primary h-4 w-4" />}
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
            <CheckCircle2 className="text-success h-3.5 w-3.5" />
          ) : (
            <XCircle className="text-destructive h-3.5 w-3.5" />
          )}
          <span className="text-muted-foreground text-[10px]">
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
      icon={<Server className="text-primary h-4 w-4" />}
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
        <div className="text-muted-foreground pt-1 text-[10px]">
          {modeDescriptions[persistenceMode]}
        </div>
      </div>
    </DiagnosticCard>
  );
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
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
      icon={<Timer className="text-primary h-4 w-4" />}
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

const DESKTOP_PLATFORM_DESCRIPTION = 'Desktop process, migration and recovery state';

function DesktopPlatformStatusSection({
  snapshot,
}: {
  readonly snapshot: DesktopPlatformDiagnosticsSnapshot;
}): ReactElement {
  return (
    <DiagnosticCard
      description={DESKTOP_PLATFORM_DESCRIPTION}
      icon={<Server className="text-primary h-4 w-4" />}
      status="neutral"
      statusLabel="Collected"
      title="Desktop Platform"
    >
      <div className="space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Migration</span>
          <span className="font-medium">{getMigrationLabel(snapshot)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Crash Recovery</span>
          <span className="font-medium">{getCrashRecoveryLabel(snapshot)}</span>
        </div>
        {snapshot.reset.status && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Reset</span>
            <span className="font-medium">{snapshot.reset.status}</span>
          </div>
        )}
        <div className="text-muted-foreground truncate pt-1 text-[10px]">
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
      icon={<Timer className="text-primary h-4 w-4" />}
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
          <div className="text-muted-foreground pt-1 text-[10px]">{snapshot.unavailableReason}</div>
        )}
      </div>
    </DiagnosticCard>
  );
}

export interface SystemDiagnosticsPanelProps {
  /** Token cache persistence mode (from TokenCacheContext) */
  readonly persistenceMode?: 'persistent' | 'memory' | 'disabled' | undefined;
  /** Token cache operational status (from TokenCacheContext) */
  readonly tokenCacheOperational?: boolean | undefined;
  /** Token cache persistence status (from TokenCacheContext) */
  readonly tokenCachePersisted?: boolean | undefined;
}

/**
 * Unified system diagnostics panel.
 *
 * Displays database status and worker status in a single consolidated
 * view for easy monitoring.
 */
export function SystemDiagnosticsPanel({
  tokenCacheOperational,
  tokenCachePersisted,
  persistenceMode,
}: SystemDiagnosticsPanelProps): ReactElement {
  const [desktopSnapshot, setDesktopSnapshot] = useState<DesktopPlatformDiagnosticsSnapshot | null>(
    null
  );
  const [desktopDiagnosticsError, setDesktopDiagnosticsError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      setDesktopDiagnosticsError(null);
      return () => {
        cancelled = true;
      };
    }
    void bridge.getSnapshot().then(
      (snapshot) => {
        if (!cancelled) {
          setDesktopSnapshot(snapshot);
          setDesktopDiagnosticsError(null);
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
    };
  }, [refreshKey]);

  const handleRefreshAll = () => {
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
  };

  return (
    <div className="space-y-6" data-testid="system-diagnostics-panel">
      {/* Header with refresh button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="text-primary h-5 w-5" />
          <div>
            <h3 className="text-lg font-semibold">System Diagnostics</h3>
            <p className="text-muted-foreground text-xs">
              Real-time health monitoring for database, indexing, and workers
            </p>
          </div>
        </div>
        <button
          aria-label="Refresh all diagnostics"
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
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
        <TokenIndexerTelemetrySection snapshot={tokenIndexerDiagnostics} />
        <RendererLongTaskStatusSection snapshot={longTaskSnapshot} />
        {desktopSnapshot && <DesktopPlatformStatusSection snapshot={desktopSnapshot} />}
        {desktopDiagnosticsError && (
          <DiagnosticCard
            description={DESKTOP_PLATFORM_DESCRIPTION}
            icon={<Server className="text-primary h-4 w-4" />}
            status="error"
            statusLabel="Issue"
            title="Desktop Platform"
          >
            <div className="text-destructive text-xs">{desktopDiagnosticsError}</div>
          </DiagnosticCard>
        )}
      </div>
    </div>
  );
}
