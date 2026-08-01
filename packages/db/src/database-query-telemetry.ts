export type DatabaseQueryFeature = 'file-tree' | 'live-query' | 'queue-stats' | 'token-estimation';

export interface DatabaseQueryTelemetryOptions {
  readonly maxSamples?: number;
  readonly now?: () => number;
  readonly windowMs?: number;
}

export interface DatabaseQueryTelemetryRecord {
  readonly durationMs: number;
  readonly failed?: boolean;
  readonly feature: DatabaseQueryFeature;
  readonly hitCount?: number;
  readonly lookupCount?: number;
}

export interface DatabaseQueryFeatureSnapshot {
  readonly durationP50Ms: number;
  readonly durationP95Ms: number;
  readonly failureCount: number;
  readonly maxDurationMs: number;
  readonly queriesPerMinute: number;
  readonly queryCount: number;
}

export interface DatabaseQueryTelemetrySnapshot {
  readonly activeLiveSubscriptions: number;
  readonly features: Record<DatabaseQueryFeature, DatabaseQueryFeatureSnapshot>;
  readonly liveUpdateCount: number;
  readonly liveUpdatesPerMinute: number;
  readonly sampleCount: number;
  readonly snapshotAt: number;
  readonly tokenEstimation: {
    readonly cacheHitRate: number | null;
    readonly hitCount: number;
    readonly lookupCount: number;
  };
  readonly windowMs: number;
}

interface QuerySample extends DatabaseQueryTelemetryRecord {
  readonly recordedAt: number;
}

const DEFAULT_MAX_SAMPLES = 512;
const DEFAULT_WINDOW_MS = 60_000;

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function featureSnapshot(
  samples: readonly QuerySample[],
  windowMs: number
): DatabaseQueryFeatureSnapshot {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  return {
    durationP50Ms: percentile(durations, 0.5),
    durationP95Ms: percentile(durations, 0.95),
    failureCount: samples.filter((sample) => sample.failed === true).length,
    maxDurationMs: durations.at(-1) ?? 0,
    queriesPerMinute: (samples.length * 60_000) / windowMs,
    queryCount: samples.length,
  };
}

export class DatabaseQueryTelemetry {
  private activeLiveSubscriptions = 0;
  private currentSnapshot: DatabaseQueryTelemetrySnapshot;
  private readonly liveUpdateTimestamps: number[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly maxSamples: number;
  private readonly now: () => number;
  private readonly querySamples: QuerySample[] = [];
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly windowMs: number;

  constructor(options: DatabaseQueryTelemetryOptions = {}) {
    this.maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
    assertPositiveInteger(this.maxSamples, 'Database query telemetry maxSamples');
    assertPositiveInteger(this.windowMs, 'Database query telemetry windowMs');
    this.currentSnapshot = this.snapshot();
  }

  readonly getSnapshot = (): DatabaseQueryTelemetrySnapshot => this.currentSnapshot;

  recordLiveSubscriptionEnded(): void {
    if (this.activeLiveSubscriptions === 0) {
      throw new Error('Database query telemetry live subscription count is already zero');
    }
    this.activeLiveSubscriptions -= 1;
    this.publish();
  }

  recordLiveSubscriptionStarted(): void {
    this.activeLiveSubscriptions += 1;
    this.publish();
  }

  recordLiveUpdate(): void {
    this.liveUpdateTimestamps.push(this.now());
    this.trimBound(this.liveUpdateTimestamps);
    this.publish();
  }

  recordQuery(record: DatabaseQueryTelemetryRecord): void {
    if (!Number.isFinite(record.durationMs) || record.durationMs < 0) {
      throw new Error('Database query telemetry durationMs must be finite and non-negative');
    }
    const lookupCount = record.lookupCount ?? 0;
    const hitCount = record.hitCount ?? 0;
    assertCount(lookupCount, 'Database query telemetry lookupCount');
    assertCount(hitCount, 'Database query telemetry hitCount');
    if (hitCount > lookupCount) {
      throw new Error('Database query telemetry hitCount cannot exceed lookupCount');
    }
    this.querySamples.push({
      ...record,
      hitCount,
      lookupCount,
      recordedAt: this.now(),
    });
    this.trimBound(this.querySamples);
    this.publish();
  }

  reset(): void {
    this.activeLiveSubscriptions = 0;
    this.liveUpdateTimestamps.length = 0;
    this.querySamples.length = 0;
    this.publish();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.refreshInterval === null) {
      this.refreshInterval = setInterval(() => {
        if (this.trimExpired()) {
          this.publish();
        }
      }, 1000);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.refreshInterval !== null) {
        clearInterval(this.refreshInterval);
        this.refreshInterval = null;
      }
    };
  };

  snapshot(): DatabaseQueryTelemetrySnapshot {
    const snapshotAt = this.now();
    const cutoff = snapshotAt - this.windowMs;
    const samples = this.querySamples.filter((sample) => sample.recordedAt >= cutoff);
    const liveUpdates = this.liveUpdateTimestamps.filter((timestamp) => timestamp >= cutoff);
    const byFeature = (feature: DatabaseQueryFeature) =>
      samples.filter((sample) => sample.feature === feature);
    const tokenSamples = byFeature('token-estimation');
    const lookupCount = tokenSamples.reduce((sum, sample) => sum + (sample.lookupCount ?? 0), 0);
    const hitCount = tokenSamples.reduce((sum, sample) => sum + (sample.hitCount ?? 0), 0);

    return {
      activeLiveSubscriptions: this.activeLiveSubscriptions,
      features: {
        'file-tree': featureSnapshot(byFeature('file-tree'), this.windowMs),
        'live-query': featureSnapshot(byFeature('live-query'), this.windowMs),
        'queue-stats': featureSnapshot(byFeature('queue-stats'), this.windowMs),
        'token-estimation': featureSnapshot(tokenSamples, this.windowMs),
      },
      liveUpdateCount: liveUpdates.length,
      liveUpdatesPerMinute: (liveUpdates.length * 60_000) / this.windowMs,
      sampleCount: samples.length,
      snapshotAt,
      tokenEstimation: {
        cacheHitRate: lookupCount === 0 ? null : hitCount / lookupCount,
        hitCount,
        lookupCount,
      },
      windowMs: this.windowMs,
    };
  }

  private trimBound<T>(samples: T[]): void {
    if (samples.length <= this.maxSamples) {
      return;
    }
    samples.splice(0, samples.length - this.maxSamples);
  }

  private trimExpired(): boolean {
    const cutoff = this.now() - this.windowMs;
    const queryCount = this.querySamples.length;
    const liveUpdateCount = this.liveUpdateTimestamps.length;
    while ((this.querySamples[0]?.recordedAt ?? cutoff) < cutoff) {
      this.querySamples.shift();
    }
    while ((this.liveUpdateTimestamps[0] ?? cutoff) < cutoff) {
      this.liveUpdateTimestamps.shift();
    }
    return (
      queryCount !== this.querySamples.length ||
      liveUpdateCount !== this.liveUpdateTimestamps.length
    );
  }

  private publish(): void {
    this.currentSnapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const databaseQueryTelemetry = new DatabaseQueryTelemetry();

export function measureDatabaseQuery<T>(
  feature: DatabaseQueryFeature,
  work: () => Promise<T>,
  counts?: { readonly hitCount: (result: T) => number; readonly lookupCount: number }
): Promise<T> {
  const startedAt = Date.now();
  return work().then(
    (result) => {
      databaseQueryTelemetry.recordQuery({
        durationMs: Date.now() - startedAt,
        feature,
        ...(counts
          ? { hitCount: counts.hitCount(result), lookupCount: counts.lookupCount }
          : undefined),
      });
      return result;
    },
    (error: unknown) => {
      databaseQueryTelemetry.recordQuery({
        durationMs: Date.now() - startedAt,
        failed: true,
        feature,
      });
      throw error;
    }
  );
}
