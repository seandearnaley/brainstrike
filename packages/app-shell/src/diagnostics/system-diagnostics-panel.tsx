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

import { useOptionalTokenCacheContext } from '@brainstrike/file-explorer-ui/indexing';
import {
  databaseStatusSelectors,
  useDatabaseStatusStore,
} from '@brainstrike/preferences/stores/database-status-store';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@brainstrike/ui';
import {
  Activity,
  CheckCircle2,
  Database,
  type LucideIcon,
  RefreshCw,
  Server,
  XCircle,
} from 'lucide-react';
import {
  lazy,
  type ReactElement,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

/** Animation duration in ms for refresh button visual feedback */
const REFRESH_ANIMATION_DURATION_MS = 500;
const LazyQueueDiagnosticsPanel = lazy(async () => {
  const module = await import('@brainstrike/vector-management');
  return { default: module.QueueDiagnosticsPanel };
});

type StatusVariant = 'success' | 'warning' | 'error' | 'loading';

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
    return candidate as DesktopDiagnosticsBridge;
  }
  return null;
}

interface DiagnosticsSettingsCategory {
  readonly content: ReactNode;
  readonly description?: string;
  readonly icon?: LucideIcon;
  readonly id: string;
  readonly keywords?: string[];
  readonly title: string;
}

interface StatusBadgeProps {
  readonly label: string;
  readonly status: StatusVariant;
}

function StatusBadge({ status, label }: StatusBadgeProps): ReactElement {
  const variantMap: Record<StatusVariant, 'default' | 'secondary' | 'destructive'> = {
    error: 'destructive',
    loading: 'secondary',
    success: 'default',
    warning: 'secondary',
  };

  return (
    <Badge className="h-5 px-2 text-[10px]" variant={variantMap[status]}>
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
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" />
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
  const [desktopDiagnosticsError, setDesktopDiagnosticsError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          setDesktopDiagnosticsError(error instanceof Error ? error.message : String(error));
        }
      }
    );
    return () => {
      cancelled = true;
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
        {desktopSnapshot && <DesktopPlatformStatusSection snapshot={desktopSnapshot} />}
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

/**
 * Connected version of SystemDiagnosticsPanel that automatically
 * reads token cache state from context when available.
 */
function ConnectedSystemDiagnosticsPanel(): ReactElement {
  const tokenCache = useOptionalTokenCacheContext();

  return (
    <SystemDiagnosticsPanel
      persistenceMode={tokenCache?.persistenceMode}
      showQueueRefresh
      tokenCacheOperational={tokenCache?.isOperational}
      tokenCachePersisted={tokenCache?.isPersisted}
    />
  );
}

/**
 * Factory function to create a System Diagnostics settings category.
 *
 * The returned category uses ConnectedSystemDiagnosticsPanel which
 * automatically reads token cache state from TokenCacheContext when
 * rendered inside a TokenCacheProvider.
 */
export function createSystemDiagnosticsSettingsCategory(): DiagnosticsSettingsCategory {
  return {
    content: <ConnectedSystemDiagnosticsPanel />,
    description: 'Monitor database, queue, and worker health in real-time.',
    icon: Activity,
    id: 'system-diagnostics',
    keywords: ['diagnostics', 'health', 'status', 'database', 'queue', 'worker', 'monitoring'],
    title: 'System Diagnostics',
  };
}
