import { Badge, StatusBar } from '@brainstrike/ui';
import { useMemo } from 'react';
import type { TelemetryTrendPoint } from './vector-status/use-vector-queue-state';

/**
 * Default dimensions for mini sparkline charts.
 * These values are optimized for the compact status bar layout.
 */
const SPARKLINE_DEFAULT_WIDTH = 40;
const SPARKLINE_DEFAULT_HEIGHT = 12;
const SPARKLINE_STROKE_WIDTH = 1;

export interface EmbeddingStatusBarProps {
  /** Additional className */
  className?: string;
  /** Latency stats */
  latencyStats: { avgMs: number; p50Ms: number; p95Ms: number };
  /** Queue counts */
  queueCounts: { queued: number; running: number; failed: number; succeeded: number };
  /** Historical telemetry data for sparklines */
  telemetryTrend: readonly TelemetryTrendPoint[];
  /** Queue throughput (jobs per minute) */
  throughput: number;
  /** Whether PGlite with pgvector is enabled */
  vectorEnabled: boolean;
  /** Worker status: 'running', 'error', 'disabled', or 'initializing' */
  workerStatus: 'running' | 'error' | 'disabled' | 'initializing';
}

/**
 * Format throughput for display
 */
function formatPerMinute(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value >= 10) {
    return value.toFixed(0);
  }
  return value.toFixed(1);
}

/**
 * Format latency for display
 */
function formatLatencyMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '—';
  }
  return `${Math.round(value)}ms`;
}

/**
 * Sparkline SVG component for mini graphs
 */
function MiniSparkline({
  values,
  ariaLabel,
  width = SPARKLINE_DEFAULT_WIDTH,
  height = SPARKLINE_DEFAULT_HEIGHT,
  className,
}: {
  readonly values: readonly number[];
  readonly ariaLabel: string;
  readonly width?: number;
  readonly height?: number;
  readonly className?: string;
}) {
  const sanitized = useMemo(() => {
    if (values.length === 0) {
      return [0];
    }
    return values.map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
  }, [values]);

  const pathData = useMemo(() => {
    const min = Math.min(...sanitized);
    const max = Math.max(...sanitized);
    const range = max - min || 1;
    const step = sanitized.length > 1 ? width / (sanitized.length - 1) : width;

    return sanitized
      .map((value, index) => {
        const x = sanitized.length === 1 ? width / 2 : index * step;
        const normalized = (value - min) / range;
        const y = height - normalized * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [sanitized, width, height]);

  const titleId = `sparkline-${ariaLabel.toLowerCase().replace(/\s+/g, '-')}`;

  return (
    <svg
      aria-labelledby={titleId}
      className={className}
      height={height}
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <title id={titleId}>{ariaLabel}</title>
      <polyline
        fill="none"
        points={pathData}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={SPARKLINE_STROKE_WIDTH}
      />
    </svg>
  );
}

/**
 * EmbeddingStatusBar - Compact status bar for embedding queue metrics.
 *
 * Displays real-time embedding queue telemetry in a three-section layout:
 * - **Left**: PG status badge (database connectivity), worker status badge
 * - **Center**: Jobs/min throughput with sparkline, P50 latency with sparkline
 * - **Right**: Queue counts (queued/running/failed/succeeded)
 *
 * Designed to sit below the DB panel footer toolbar and provide at-a-glance
 * visibility into embedding pipeline health.
 *
 * @example
 * ```tsx
 * <EmbeddingStatusBar
 *   vectorEnabled={true}
 *   workerStatus="running"
 *   throughput={10.5}
 *   latencyStats={{ avgMs: 100, p50Ms: 95, p95Ms: 150 }}
 *   queueCounts={{ queued: 5, running: 2, failed: 0, succeeded: 100 }}
 *   telemetryTrend={trendData}
 * />
 * ```
 *
 * @see useEmbeddingControls - Hook that provides props for this component
 */
export function EmbeddingStatusBar({
  vectorEnabled,
  workerStatus,
  throughput,
  latencyStats,
  queueCounts,
  telemetryTrend,
  className,
}: EmbeddingStatusBarProps) {
  const throughputTrend = useMemo(
    () => telemetryTrend.map((point) => point.throughput),
    [telemetryTrend]
  );

  const latencyTrend = useMemo(
    () => telemetryTrend.map((point) => point.latencyP95),
    [telemetryTrend]
  );

  // Left content: Status badges
  const leftContent = (
    <div className="flex items-center gap-1.5">
      <Badge className="h-4 px-1 py-0 text-[9px]" variant={vectorEnabled ? 'default' : 'outline'}>
        {vectorEnabled ? 'PG' : 'PG: OFF'}
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
        {workerStatus === 'running' ? '● RUN' : workerStatus === 'error' ? '✕ ERR' : '○ IDLE'}
      </Badge>
    </div>
  );

  // Center content: Throughput and latency with sparklines
  const centerContent = (
    <div className="flex items-center gap-3">
      {/* Throughput */}
      <div className="flex items-center gap-1.5">
        <MiniSparkline
          ariaLabel="Throughput trend"
          className="text-success"
          values={throughputTrend}
        />
        <span className="font-medium text-[10px]">{formatPerMinute(throughput)}</span>
        <span className="text-[9px] text-muted-foreground">jobs/min</span>
      </div>

      {/* Latency */}
      <div className="flex items-center gap-1.5">
        <MiniSparkline ariaLabel="Latency trend" className="text-info" values={latencyTrend} />
        <span className="font-medium text-[10px]">{formatLatencyMs(latencyStats.p50Ms)}</span>
        <span className="text-[9px] text-muted-foreground">P50</span>
      </div>
    </div>
  );

  // Right content: Queue counts
  const rightContent = (
    <div className="flex items-center gap-1.5 text-[10px]">
      <span className="text-muted-foreground">Q:</span>
      <span className="font-medium">{queueCounts.queued}</span>
      <span className="text-muted-foreground">/</span>
      <span className="font-medium">{queueCounts.running}</span>
      {queueCounts.failed > 0 && (
        <>
          <span className="text-muted-foreground">/</span>
          <span className="font-medium text-destructive">{queueCounts.failed}</span>
        </>
      )}
      {queueCounts.succeeded > 0 && (
        <span className="ml-1 text-success">✓{queueCounts.succeeded}</span>
      )}
    </div>
  );

  return (
    <StatusBar
      centerContent={centerContent}
      leftContent={leftContent}
      rightContent={rightContent}
      testId="embedding-status-bar"
      {...(className ? { className } : {})}
    />
  );
}
