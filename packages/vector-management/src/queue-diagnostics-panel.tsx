/**
 * Centralized queue diagnostics panel (BST-166).
 *
 * Displays consolidated health metrics from both durable (JobQueue) and
 * ephemeral (workerpool) queue systems in a unified view.
 */

import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import type { QueueHealthMetrics } from '@brainstrike/queue';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  Gauge,
  RefreshCw,
  Server,
  XCircle,
  Zap,
} from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { useQueueHealthMetrics } from './use-queue-health-metrics';

interface MetricCardProps {
  readonly icon?: ReactNode;
  readonly label: string;
  readonly tooltip?: string;
  readonly value: string | number;
  readonly variant?: 'default' | 'success' | 'warning' | 'error';
}

const VARIANT_STYLES: Record<NonNullable<MetricCardProps['variant']>, string> = {
  default: 'text-foreground',
  error: 'text-destructive',
  success: 'text-success',
  warning: 'text-warning',
};

function MetricCard({
  label,
  value,
  icon,
  variant = 'default',
  tooltip,
}: MetricCardProps): ReactElement {
  const content = (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`font-semibold text-sm ${VARIANT_STYLES[variant]}`}>{value}</div>
    </div>
  );

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-help">{content}</div>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          <span className="text-xs">{tooltip}</span>
        </TooltipContent>
      </Tooltip>
    );
  }

  return content;
}

interface SectionHeaderProps {
  readonly icon: ReactNode;
  readonly status: 'available' | 'unavailable';
  readonly title: string;
}

function SectionHeader({ title, icon, status }: SectionHeaderProps): ReactElement {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1.5 font-medium text-xs">
        {icon}
        <span>{title}</span>
      </div>
      <Badge
        className="h-4 px-1 py-0 text-[9px]"
        variant={status === 'available' ? 'default' : 'secondary'}
      >
        {status === 'available' ? 'Connected' : 'Unavailable'}
      </Badge>
    </div>
  );
}

function formatLatency(ms: number | null): string {
  if (ms === null) {
    return '—';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatThroughput(tpm: number): string {
  if (tpm < 0.1) {
    return '0';
  }
  if (tpm < 10) {
    return tpm.toFixed(1);
  }
  return Math.round(tpm).toString();
}

interface StatusIndicatorProps {
  readonly hasErrors: boolean;
  readonly totalActive: number;
  readonly totalFailed: number;
}

function StatusIndicator({
  hasErrors,
  totalActive,
  totalFailed,
}: StatusIndicatorProps): ReactElement {
  const getIcon = () => {
    if (hasErrors) {
      return <AlertTriangle className="h-4 w-4 text-warning" />;
    }
    if (totalActive > 0) {
      return <Zap className="h-4 w-4 text-info" />;
    }
    return <CheckCircle2 className="h-4 w-4 text-success" />;
  };

  const getMessage = () => {
    if (hasErrors) {
      return `${totalFailed} failed tasks`;
    }
    if (totalActive > 0) {
      return `${totalActive} tasks active`;
    }
    return 'All systems operational';
  };

  return (
    <Tooltip>
      <TooltipTrigger>{getIcon()}</TooltipTrigger>
      <TooltipContent side="left" sideOffset={4}>
        <span className="text-xs">{getMessage()}</span>
      </TooltipContent>
    </Tooltip>
  );
}

interface DurableQueueSectionProps {
  readonly durableQueue: QueueHealthMetrics['durableQueue'];
  readonly lastUpdated: number;
}

function DurableQueueSection({
  durableQueue,
  lastUpdated,
}: DurableQueueSectionProps): ReactElement {
  return (
    <div className="space-y-2">
      <SectionHeader
        icon={<Database className="h-3 w-3" />}
        status={durableQueue ? 'available' : 'unavailable'}
        title="Durable Queue (DB)"
      />
      {durableQueue ? (
        <div className="grid grid-cols-4 gap-3">
          <MetricCard
            icon={<Clock className="h-3 w-3" />}
            label="Queued"
            tooltip="Jobs waiting to be processed"
            value={durableQueue.queued}
          />
          <MetricCard
            icon={<Zap className="h-3 w-3" />}
            label="Running"
            tooltip="Jobs currently being processed"
            value={durableQueue.running}
            variant={durableQueue.running > 0 ? 'success' : 'default'}
          />
          <MetricCard
            icon={<XCircle className="h-3 w-3" />}
            label="Failed"
            tooltip="Jobs that failed after all retries"
            value={durableQueue.failed}
            variant={durableQueue.failed > 0 ? 'error' : 'default'}
          />
          <MetricCard
            icon={<CheckCircle2 className="h-3 w-3" />}
            label="Succeeded"
            tooltip="Successfully completed jobs"
            value={durableQueue.succeeded}
            variant="success"
          />
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground">Database not connected</p>
      )}
      {durableQueue && lastUpdated > 0 && (
        <div className="flex justify-end text-[9px] text-muted-foreground">
          Updated: {new Date(lastUpdated).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

interface EphemeralQueueSectionProps {
  readonly compact: boolean;
  readonly ephemeralQueue: QueueHealthMetrics['ephemeralQueue'];
}

function EphemeralQueueSection({
  ephemeralQueue,
  compact,
}: EphemeralQueueSectionProps): ReactElement {
  return (
    <div className="space-y-2">
      <SectionHeader
        icon={<Server className="h-3 w-3" />}
        status={ephemeralQueue ? 'available' : 'unavailable'}
        title="Ephemeral Queue (Runtime)"
      />
      {ephemeralQueue ? (
        <EphemeralQueueMetricsDisplay compact={compact} ephemeralQueue={ephemeralQueue} />
      ) : (
        <p className="text-[10px] text-muted-foreground">Workerpool not initialized</p>
      )}
    </div>
  );
}

interface EphemeralQueueMetricsDisplayProps {
  readonly compact: boolean;
  readonly ephemeralQueue: NonNullable<QueueHealthMetrics['ephemeralQueue']>;
}

function EphemeralQueueMetricsDisplay({
  ephemeralQueue,
  compact,
}: EphemeralQueueMetricsDisplayProps): ReactElement {
  return (
    <>
      <div className="grid grid-cols-4 gap-3">
        <MetricCard
          icon={<Activity className="h-3 w-3" />}
          label="Active"
          tooltip="Tasks currently in the worker pool"
          value={ephemeralQueue.active}
          variant={ephemeralQueue.active > 0 ? 'success' : 'default'}
        />
        <MetricCard
          icon={<CheckCircle2 className="h-3 w-3" />}
          label="Completed"
          tooltip="Tasks completed this session"
          value={ephemeralQueue.completed}
          variant="success"
        />
        <MetricCard
          icon={<XCircle className="h-3 w-3" />}
          label="Failed"
          tooltip="Tasks failed this session"
          value={ephemeralQueue.failed}
          variant={ephemeralQueue.failed > 0 ? 'error' : 'default'}
        />
        <MetricCard
          icon={<Clock className="h-3 w-3" />}
          label="Enqueued"
          tooltip="Total tasks enqueued this session"
          value={ephemeralQueue.totalEnqueued}
        />
      </div>

      {/* Performance Metrics */}
      {!compact && <PerformanceMetricsDisplay ephemeralQueue={ephemeralQueue} />}

      {/* Last Error */}
      {ephemeralQueue.lastError && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[10px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="line-clamp-2">{ephemeralQueue.lastError}</span>
        </div>
      )}
    </>
  );
}

interface PerformanceMetricsDisplayProps {
  readonly ephemeralQueue: NonNullable<QueueHealthMetrics['ephemeralQueue']>;
}

function PerformanceMetricsDisplay({
  ephemeralQueue,
}: PerformanceMetricsDisplayProps): ReactElement {
  const p95Variant =
    ephemeralQueue.latencyP95Ms && ephemeralQueue.latencyP95Ms > 5000 ? 'warning' : 'default';

  return (
    <div className="mt-2 grid grid-cols-4 gap-3 rounded-md bg-muted/50 p-2">
      <MetricCard
        icon={<Gauge className="h-3 w-3" />}
        label="Throughput"
        tooltip="Tasks per minute (60s window)"
        value={`${formatThroughput(ephemeralQueue.throughputPerMinute)}/min`}
      />
      <MetricCard
        label="Avg Latency"
        tooltip="Average task completion time"
        value={formatLatency(ephemeralQueue.latencyAvgMs)}
      />
      <MetricCard
        label="P50"
        tooltip="50th percentile latency"
        value={formatLatency(ephemeralQueue.latencyP50Ms)}
      />
      <MetricCard
        label="P95"
        tooltip="95th percentile latency"
        value={formatLatency(ephemeralQueue.latencyP95Ms)}
        variant={p95Variant}
      />
    </div>
  );
}

interface WorkerHealthSectionProps {
  readonly workerHealth: QueueHealthMetrics['workerHealth'];
}

function WorkerHealthSection({ workerHealth }: WorkerHealthSectionProps): ReactElement | null {
  if (!workerHealth) {
    return null;
  }

  return (
    <>
      <div className="border-t" />
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Worker Status</span>
        <Badge
          className="h-4 px-1.5 text-[9px]"
          variant={workerHealth.isReady ? 'default' : 'destructive'}
        >
          {workerHealth.state}
        </Badge>
      </div>
    </>
  );
}

interface QueueDiagnosticsPanelProps {
  /** Compact mode for smaller displays */
  readonly compact?: boolean;
  /** Custom metrics (for testing) - if not provided, uses useQueueHealthMetrics hook */
  readonly metrics?: QueueHealthMetrics;
  /**
   * Show refresh button.
   * Ignored when `metrics` is provided because externally supplied metrics
   * cannot be refreshed by this component.
   */
  readonly showRefresh?: boolean;
}

interface QueueDiagnosticsPanelContentProps {
  readonly compact: boolean;
  readonly isLoading: boolean;
  readonly metrics: QueueHealthMetrics;
  readonly onRefresh?: () => Promise<void>;
  readonly showRefresh: boolean;
}

function QueueDiagnosticsPanelContent({
  metrics,
  isLoading,
  compact,
  onRefresh,
  showRefresh,
}: QueueDiagnosticsPanelContentProps): ReactElement {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (!onRefresh) {
      return;
    }
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh]);

  const { durableQueue, ephemeralQueue, workerHealth } = metrics;

  // Calculate combined stats
  const totalActive = (durableQueue?.running ?? 0) + (ephemeralQueue?.active ?? 0);
  const totalFailed = (durableQueue?.failed ?? 0) + (ephemeralQueue?.failed ?? 0);
  const hasErrors = totalFailed > 0 || Boolean(ephemeralQueue?.lastError);

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="border-b px-3 py-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4" />
            Queue Diagnostics
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-3">
          <div className="h-16 w-full animate-pulse rounded bg-muted" />
          <div className="h-16 w-full animate-pulse rounded bg-muted" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="border-b px-3 py-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="h-4 w-4" />
              Queue Diagnostics
            </CardTitle>
            {!compact && (
              <CardDescription className="mt-0.5 text-[10px]">
                Real-time queue health and performance metrics
              </CardDescription>
            )}
          </div>
          <div className="flex items-center gap-2">
            <StatusIndicator
              hasErrors={hasErrors}
              totalActive={totalActive}
              totalFailed={totalFailed}
            />

            {/* Refresh button */}
            {showRefresh && onRefresh && (
              <button
                aria-label="Refresh metrics"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                disabled={isRefreshing}
                onClick={handleRefresh}
                type="button"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 p-3">
        <DurableQueueSection durableQueue={durableQueue} lastUpdated={metrics.lastUpdated} />

        <div className="border-t" />

        <EphemeralQueueSection compact={compact} ephemeralQueue={ephemeralQueue} />

        <WorkerHealthSection workerHealth={workerHealth} />
      </CardContent>
    </Card>
  );
}

function QueueDiagnosticsPanelWithHook({
  compact,
  showRefresh,
}: {
  compact: boolean;
  showRefresh: boolean;
}): ReactElement {
  const hookResult = useQueueHealthMetrics();
  const durableQueuePolledAt = useVectorStatusUIStore((state) => state.durableQueuePolledAt);
  const metrics = {
    ...hookResult.metrics,
    lastUpdated: durableQueuePolledAt ?? hookResult.metrics.lastUpdated,
  };

  return (
    <QueueDiagnosticsPanelContent
      compact={compact}
      isLoading={hookResult.isLoading}
      metrics={metrics}
      onRefresh={hookResult.refresh}
      showRefresh={showRefresh}
    />
  );
}

/**
 * Consolidated queue diagnostics panel.
 *
 * Displays:
 * - Durable queue stats (from JobQueue/DB)
 * - Ephemeral queue metrics (from workerpool/runtime)
 * - Worker health status
 * - Performance metrics (throughput, latency)
 */
export function QueueDiagnosticsPanel({
  metrics,
  showRefresh = true,
  compact = false,
}: QueueDiagnosticsPanelProps): ReactElement {
  if (metrics !== undefined) {
    return (
      <QueueDiagnosticsPanelContent
        compact={compact}
        isLoading={false}
        metrics={metrics}
        showRefresh={false}
      />
    );
  }

  return <QueueDiagnosticsPanelWithHook compact={compact} showRefresh={showRefresh} />;
}
