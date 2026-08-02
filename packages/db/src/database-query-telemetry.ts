import { createLogger } from '@brainstrike/utils';

export type DatabaseQueryFeature = 'file-tree' | 'live-query' | 'queue-stats' | 'token-estimation';

export interface DatabaseQueryTelemetryOptions {
  readonly maxSamples?: number;
  /** Monotonic retention clock. Defaults to Performance.now(). */
  readonly now?: () => number;
  /** Epoch clock used only for the externally reported snapshotAt field. */
  readonly wallNow?: () => number;
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
  /** Rolling overflow count aggregated into bounded buckets of at most one second. */
  readonly droppedSampleCount: number;
  readonly durationP50Ms: number;
  readonly durationP95Ms: number;
  readonly failureCount: number;
  readonly maxDurationMs: number;
  readonly queriesPerMinute: number;
  readonly queryCount: number;
}

export interface DatabaseQueryTelemetrySnapshot {
  readonly activeLiveSubscriptions: number;
  /** Rolling overflow count aggregated into bounded buckets of at most one second. */
  readonly droppedSampleCount: number;
  readonly features: Record<DatabaseQueryFeature, DatabaseQueryFeatureSnapshot>;
  /** Rolling count aggregated into buckets of at most one second. */
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

interface CountBucket {
  count: number;
  readonly startedAt: number;
}

interface QuerySample {
  readonly durationMs: number;
  readonly failed?: boolean;
  readonly feature: DatabaseQueryFeature;
  readonly hitCount: number;
  readonly lookupCount: number;
  readonly recordedAt: number;
}

const DATABASE_QUERY_FEATURES: readonly DatabaseQueryFeature[] = [
  'file-tree',
  'live-query',
  'queue-stats',
  'token-estimation',
];
const DEFAULT_MAX_SAMPLES_PER_FEATURE = 512;
const DEFAULT_WINDOW_MS = 60_000;
const NOTIFY_INTERVAL_MS = 1000;
const DATABASE_QUERY_FEATURE_SET: ReadonlySet<string> = new Set(DATABASE_QUERY_FEATURES);
const DATABASE_QUERY_RECORD_FIELDS = new Set([
  'durationMs',
  'failed',
  'feature',
  'hitCount',
  'lookupCount',
]);
const logger = createLogger('DatabaseQueryTelemetry');

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

function assertDatabaseQueryRecordShape(
  record: unknown
): asserts record is DatabaseQueryTelemetryRecord {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new Error('Database query telemetry record must be an object');
  }
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !DATABASE_QUERY_RECORD_FIELDS.has(key)) {
      throw new Error(`Database query telemetry record contains unsupported field: ${String(key)}`);
    }
  }
}

function assertDatabaseQueryRecordValues(
  failed: unknown,
  feature: unknown
): asserts feature is DatabaseQueryFeature {
  if (!(typeof feature === 'string' && DATABASE_QUERY_FEATURE_SET.has(feature))) {
    throw new Error(`Database query telemetry feature is unsupported: ${String(feature)}`);
  }
  if (failed !== undefined && typeof failed !== 'boolean') {
    throw new Error('Database query telemetry failed must be a boolean when provided');
  }
}

function readMonotonicTime(): number {
  if (typeof performance === 'undefined' || typeof performance.now !== 'function') {
    throw new Error('Database query telemetry requires the Performance monotonic clock');
  }
  return performance.now();
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function featureSnapshot(
  samples: readonly QuerySample[],
  windowMs: number,
  droppedSampleCount: number
): DatabaseQueryFeatureSnapshot {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  return {
    droppedSampleCount,
    durationP50Ms: percentile(durations, 0.5),
    durationP95Ms: percentile(durations, 0.95),
    failureCount: samples.filter((sample) => sample.failed === true).length,
    maxDurationMs: durations.at(-1) ?? 0,
    queriesPerMinute: (samples.length * 60_000) / windowMs,
    queryCount: samples.length,
  };
}

function createInitialSnapshot(windowMs: number): DatabaseQueryTelemetrySnapshot {
  return {
    activeLiveSubscriptions: 0,
    droppedSampleCount: 0,
    features: {
      'file-tree': featureSnapshot([], windowMs, 0),
      'live-query': featureSnapshot([], windowMs, 0),
      'queue-stats': featureSnapshot([], windowMs, 0),
      'token-estimation': featureSnapshot([], windowMs, 0),
    },
    liveUpdateCount: 0,
    liveUpdatesPerMinute: 0,
    sampleCount: 0,
    snapshotAt: 0,
    tokenEstimation: {
      cacheHitRate: null,
      hitCount: 0,
      lookupCount: 0,
    },
    windowMs,
  };
}

function createFeatureArrays<T>(factory: () => T): Record<DatabaseQueryFeature, T> {
  return {
    'file-tree': factory(),
    'live-query': factory(),
    'queue-stats': factory(),
    'token-estimation': factory(),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safelyRecordTelemetry(operation: string, record: () => void): void {
  try {
    record();
  } catch (error) {
    logger.error('Database query telemetry recording failed', {
      error: getErrorMessage(error),
      operation,
    });
  }
}

function readQueryMeasurementStart(feature: DatabaseQueryFeature): number | null {
  try {
    return readMonotonicTime();
  } catch (error) {
    logger.error('Database query telemetry timing unavailable; query will continue', {
      error: getErrorMessage(error),
      operation: `${feature}-query`,
    });
    return null;
  }
}

export class DatabaseQueryTelemetry {
  private activeLiveSubscriptions = 0;
  private currentSnapshot: DatabaseQueryTelemetrySnapshot;
  private dirty = true;
  private readonly droppedSampleBucketMs: number;
  private readonly droppedSampleBuckets = createFeatureArrays<CountBucket[]>(() => []);
  private readonly liveUpdateBucketMs: number;
  private readonly liveUpdateBuckets: CountBucket[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly maxSamples: number;
  private readonly now: () => number;
  private notifyTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly querySamples = createFeatureArrays<QuerySample[]>(() => []);
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly wallNow: () => number;
  private readonly windowMs: number;

  constructor(options: DatabaseQueryTelemetryOptions = {}) {
    this.maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES_PER_FEATURE;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.droppedSampleBucketMs = Math.max(
      1,
      Math.min(NOTIFY_INTERVAL_MS, Math.floor(this.windowMs / 60))
    );
    this.liveUpdateBucketMs = this.droppedSampleBucketMs;
    this.now = options.now ?? readMonotonicTime;
    this.wallNow = options.wallNow ?? Date.now;
    assertPositiveInteger(this.maxSamples, 'Database query telemetry maxSamples');
    assertPositiveInteger(this.windowMs, 'Database query telemetry windowMs');
    this.currentSnapshot = createInitialSnapshot(this.windowMs);
  }

  readonly getSnapshot = (): DatabaseQueryTelemetrySnapshot => {
    if (this.listeners.size > 0) {
      return this.currentSnapshot;
    }
    const retentionAt = this.readRetentionNow();
    if (this.trimExpired(retentionAt)) {
      this.dirty = true;
    }
    if (this.dirty) {
      this.publishSnapshot(retentionAt);
    }
    return this.currentSnapshot;
  };

  recordLiveSubscriptionEnded(): void {
    if (this.activeLiveSubscriptions === 0) {
      throw new Error('Database query telemetry live subscription count is already zero');
    }
    this.activeLiveSubscriptions -= 1;
    this.markDirty();
  }

  recordLiveSubscriptionStarted(): void {
    this.activeLiveSubscriptions += 1;
    this.markDirty();
  }

  recordLiveUpdate(): void {
    const recordedAt = this.readRetentionNow();
    this.recordCount(this.liveUpdateBuckets, this.liveUpdateBucketMs, recordedAt);
    this.trimCountBuckets(
      this.liveUpdateBuckets,
      this.liveUpdateBucketMs,
      recordedAt - this.windowMs
    );
    this.markDirty();
  }

  recordQuery(record: DatabaseQueryTelemetryRecord): void {
    assertDatabaseQueryRecordShape(record);
    const {
      durationMs,
      failed,
      feature,
      hitCount: suppliedHitCount,
      lookupCount: suppliedLookupCount,
    } = record;
    assertDatabaseQueryRecordValues(failed, feature);
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error('Database query telemetry durationMs must be finite and non-negative');
    }
    const lookupCount = suppliedLookupCount ?? 0;
    const hitCount = suppliedHitCount ?? 0;
    assertCount(lookupCount, 'Database query telemetry lookupCount');
    assertCount(hitCount, 'Database query telemetry hitCount');
    if (hitCount > lookupCount) {
      throw new Error('Database query telemetry hitCount cannot exceed lookupCount');
    }

    const recordedAt = this.readRetentionNow();
    this.trimExpired(recordedAt);
    const featureSamples = this.querySamples[feature];
    featureSamples.push({
      durationMs,
      feature,
      hitCount,
      lookupCount,
      recordedAt,
      ...(failed === undefined ? {} : { failed }),
    });
    if (featureSamples.length > this.maxSamples) {
      featureSamples.shift();
      this.recordCount(this.droppedSampleBuckets[feature], this.droppedSampleBucketMs, recordedAt);
    }
    this.markDirty();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0) {
      const retentionAt = this.readRetentionNow();
      if (this.trimExpired(retentionAt) || this.dirty) {
        this.publishSnapshot(retentionAt);
      }
    }
    this.listeners.add(listener);
    if (this.refreshInterval === null) {
      this.refreshInterval = setInterval(() => {
        if (!this.trimExpired()) {
          return;
        }
        this.dirty = true;
        this.notifyListeners();
      }, NOTIFY_INTERVAL_MS);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size !== 0) {
        return;
      }
      if (this.refreshInterval !== null) {
        clearInterval(this.refreshInterval);
        this.refreshInterval = null;
      }
      if (this.notifyTimeout !== null) {
        clearTimeout(this.notifyTimeout);
        this.notifyTimeout = null;
      }
    };
  };

  snapshot(): DatabaseQueryTelemetrySnapshot {
    const retentionAt = this.readRetentionNow();
    this.trimExpired(retentionAt);
    return this.buildSnapshot(retentionAt);
  }

  private buildSnapshot(retentionAt: number): DatabaseQueryTelemetrySnapshot {
    const cutoff = retentionAt - this.windowMs;
    const samples = createFeatureArrays<QuerySample[]>(() => []);
    for (const feature of DATABASE_QUERY_FEATURES) {
      samples[feature] = this.querySamples[feature].filter((sample) => sample.recordedAt >= cutoff);
    }
    const liveUpdateCount = this.liveUpdateBuckets
      .filter((bucket) => bucket.startedAt + this.liveUpdateBucketMs > cutoff)
      .reduce((total, bucket) => total + bucket.count, 0);
    const droppedSampleCounts = createFeatureArrays(() => 0);
    for (const feature of DATABASE_QUERY_FEATURES) {
      droppedSampleCounts[feature] = this.droppedSampleBuckets[feature]
        .filter((bucket) => bucket.startedAt + this.droppedSampleBucketMs > cutoff)
        .reduce((total, bucket) => total + bucket.count, 0);
    }
    const tokenSamples = samples['token-estimation'];
    const lookupCount = tokenSamples.reduce((sum, sample) => sum + (sample.lookupCount ?? 0), 0);
    const hitCount = tokenSamples.reduce((sum, sample) => sum + (sample.hitCount ?? 0), 0);

    return {
      activeLiveSubscriptions: this.activeLiveSubscriptions,
      droppedSampleCount: DATABASE_QUERY_FEATURES.reduce(
        (total, feature) => total + droppedSampleCounts[feature],
        0
      ),
      features: {
        'file-tree': featureSnapshot(
          samples['file-tree'],
          this.windowMs,
          droppedSampleCounts['file-tree']
        ),
        'live-query': featureSnapshot(
          samples['live-query'],
          this.windowMs,
          droppedSampleCounts['live-query']
        ),
        'queue-stats': featureSnapshot(
          samples['queue-stats'],
          this.windowMs,
          droppedSampleCounts['queue-stats']
        ),
        'token-estimation': featureSnapshot(
          tokenSamples,
          this.windowMs,
          droppedSampleCounts['token-estimation']
        ),
      },
      liveUpdateCount,
      liveUpdatesPerMinute: (liveUpdateCount * 60_000) / this.windowMs,
      sampleCount: DATABASE_QUERY_FEATURES.reduce(
        (total, feature) => total + samples[feature].length,
        0
      ),
      snapshotAt: this.readWallNow(),
      tokenEstimation: {
        cacheHitRate: lookupCount === 0 ? null : hitCount / lookupCount,
        hitCount,
        lookupCount,
      },
      windowMs: this.windowMs,
    };
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.listeners.size === 0 || this.notifyTimeout !== null) {
      return;
    }
    this.notifyTimeout = setTimeout(() => {
      this.notifyTimeout = null;
      this.notifyListeners();
    }, NOTIFY_INTERVAL_MS);
  }

  private notifyListeners(): void {
    this.publishSnapshot(this.readRetentionNow());
    for (const listener of this.listeners) {
      listener();
    }
  }

  private publishSnapshot(retentionAt: number): void {
    this.trimExpired(retentionAt);
    this.currentSnapshot = this.buildSnapshot(retentionAt);
    this.dirty = false;
  }

  private readRetentionNow(): number {
    const retentionAt = this.now();
    if (!Number.isFinite(retentionAt) || retentionAt < 0) {
      throw new Error('Database query telemetry monotonic clock must be finite and non-negative');
    }
    return retentionAt;
  }

  private readWallNow(): number {
    const snapshotAt = this.wallNow();
    if (!Number.isFinite(snapshotAt)) {
      throw new Error('Database query telemetry wall clock must be finite');
    }
    return snapshotAt;
  }

  private recordCount(buckets: CountBucket[], bucketMs: number, recordedAt: number): void {
    const startedAt = Math.floor(recordedAt / bucketMs) * bucketMs;
    const latestBucket = buckets.at(-1);
    if (!latestBucket || latestBucket.startedAt < startedAt) {
      buckets.push({ count: 1, startedAt });
      return;
    }
    if (latestBucket.startedAt === startedAt) {
      latestBucket.count += 1;
      return;
    }
    throw new Error('Database query telemetry count-bucket monotonicity invariant failed');
  }

  private trimCountBuckets(buckets: CountBucket[], bucketMs: number, cutoff: number): boolean {
    let changed = false;
    while ((buckets[0]?.startedAt ?? cutoff) + bucketMs <= cutoff) {
      buckets.shift();
      changed = true;
    }
    return changed;
  }

  private trimExpired(snapshotAt = this.readRetentionNow()): boolean {
    const cutoff = snapshotAt - this.windowMs;
    let changed = false;
    for (const feature of DATABASE_QUERY_FEATURES) {
      const featureSamples = this.querySamples[feature];
      while ((featureSamples[0]?.recordedAt ?? cutoff) < cutoff) {
        featureSamples.shift();
        changed = true;
      }
      changed =
        this.trimCountBuckets(
          this.droppedSampleBuckets[feature],
          this.droppedSampleBucketMs,
          cutoff
        ) || changed;
    }
    return (
      this.trimCountBuckets(this.liveUpdateBuckets, this.liveUpdateBucketMs, cutoff) || changed
    );
  }
}

export const databaseQueryTelemetry = new DatabaseQueryTelemetry();

export function recordDatabaseLiveSubscriptionEnded(): void {
  safelyRecordTelemetry('live-subscription-ended', () => {
    databaseQueryTelemetry.recordLiveSubscriptionEnded();
  });
}

export function recordDatabaseLiveSubscriptionStarted(): void {
  safelyRecordTelemetry('live-subscription-started', () => {
    databaseQueryTelemetry.recordLiveSubscriptionStarted();
  });
}

export function recordDatabaseLiveUpdate(): void {
  safelyRecordTelemetry('live-update', () => {
    databaseQueryTelemetry.recordLiveUpdate();
  });
}

export async function measureDatabaseQuery<T>(
  feature: DatabaseQueryFeature,
  work: () => Promise<T>,
  counts?: { readonly hitCount: (result: T) => number; readonly lookupCount: number }
): Promise<T> {
  const startedAt = readQueryMeasurementStart(feature);
  try {
    const result = await work();
    if (startedAt !== null) {
      safelyRecordTelemetry(`${feature}-query`, () => {
        databaseQueryTelemetry.recordQuery({
          durationMs: readMonotonicTime() - startedAt,
          feature,
          ...(counts
            ? { hitCount: counts.hitCount(result), lookupCount: counts.lookupCount }
            : undefined),
        });
      });
    }
    return result;
  } catch (error) {
    if (startedAt !== null) {
      safelyRecordTelemetry(`${feature}-query-failed`, () => {
        databaseQueryTelemetry.recordQuery({
          durationMs: readMonotonicTime() - startedAt,
          failed: true,
          feature,
        });
      });
    }
    throw error;
  }
}
