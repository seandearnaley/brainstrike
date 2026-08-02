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
  /** Rolling query arrival count, independent of the retained percentile samples. */
  readonly queryCount: number;
}

export interface DatabaseQueryTelemetrySnapshot {
  readonly activeLiveSubscriptions: number;
  readonly availability: 'active' | 'failed';
  /** Rolling overflow count aggregated into bounded buckets of at most one second. */
  readonly droppedSampleCount: number;
  readonly features: Record<DatabaseQueryFeature, DatabaseQueryFeatureSnapshot>;
  /** Rolling count aggregated into buckets of at most one second. */
  readonly liveUpdateCount: number;
  readonly liveUpdatesPerMinute: number;
  /** Total duration samples retained across the per-feature percentile buffers. */
  readonly sampleCount: number;
  readonly snapshotAt: number;
  readonly tokenEstimation: {
    readonly cacheHitRate: number | null;
    readonly hitCount: number;
    readonly lookupCount: number;
  };
  readonly unavailableReason: string | null;
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
  const timestamp = performance.now();
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error('Database query telemetry monotonic clock must be finite and non-negative');
  }
  return timestamp;
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
  droppedSampleCount: number,
  queryCount: number,
  failureCount: number
): DatabaseQueryFeatureSnapshot {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  return {
    droppedSampleCount,
    durationP50Ms: percentile(durations, 0.5),
    durationP95Ms: percentile(durations, 0.95),
    failureCount,
    maxDurationMs: durations.at(-1) ?? 0,
    queriesPerMinute: (queryCount * 60_000) / windowMs,
    queryCount,
  };
}

function createInitialSnapshot(windowMs: number): DatabaseQueryTelemetrySnapshot {
  return {
    activeLiveSubscriptions: 0,
    availability: 'active',
    droppedSampleCount: 0,
    features: {
      'file-tree': featureSnapshot([], windowMs, 0, 0, 0),
      'live-query': featureSnapshot([], windowMs, 0, 0, 0),
      'queue-stats': featureSnapshot([], windowMs, 0, 0, 0),
      'token-estimation': featureSnapshot([], windowMs, 0, 0, 0),
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
    unavailableReason: null,
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

interface FailedQueryMeasurementClock {
  readonly clock: Performance | null;
  readonly read: unknown;
}

const FAILED_CLOCK_READ = Symbol('failed-clock-read');
let failedQueryMeasurementClock: FailedQueryMeasurementClock | null = null;

function readQueryMeasurementClock(feature: DatabaseQueryFeature): number | null {
  const clock = typeof performance === 'undefined' ? null : performance;
  let read: unknown;
  try {
    read = clock?.now;
  } catch (error) {
    if (
      failedQueryMeasurementClock?.clock === clock &&
      failedQueryMeasurementClock.read === FAILED_CLOCK_READ
    ) {
      return null;
    }
    failedQueryMeasurementClock = { clock, read: FAILED_CLOCK_READ };
    logger.error('Database query telemetry timing unavailable; query will continue', {
      error: getErrorMessage(error),
      operation: `${feature}-query`,
    });
    return null;
  }
  if (failedQueryMeasurementClock?.clock === clock && failedQueryMeasurementClock.read === read) {
    // A failed clock identity is permanently unavailable. Test/runtime clock
    // replacement is a distinct capability and may be probed independently.
    return null;
  }
  try {
    return readMonotonicTime();
  } catch (error) {
    failedQueryMeasurementClock = { clock, read };
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
  private readonly failureCountBuckets = createFeatureArrays<CountBucket[]>(() => []);
  private readonly liveUpdateBucketMs: number;
  private readonly liveUpdateBuckets: CountBucket[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly maxSamples: number;
  private readonly now: () => number;
  private notifyTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly queryCountBucketMs: number;
  private readonly queryCountBuckets = createFeatureArrays<CountBucket[]>(() => []);
  private readonly querySamples = createFeatureArrays<QuerySample[]>(() => []);
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private retentionClockFailure: Error | null = null;
  private readonly tokenHitCountBuckets: CountBucket[] = [];
  private readonly tokenLookupCountBuckets: CountBucket[] = [];
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
    this.queryCountBucketMs = this.droppedSampleBucketMs;
    this.now = options.now ?? readMonotonicTime;
    this.wallNow = options.wallNow ?? Date.now;
    assertPositiveInteger(this.maxSamples, 'Database query telemetry maxSamples');
    assertPositiveInteger(this.windowMs, 'Database query telemetry windowMs');
    this.currentSnapshot = createInitialSnapshot(this.windowMs);
  }

  readonly getSnapshot = (): DatabaseQueryTelemetrySnapshot => {
    if (this.retentionClockFailure !== null) {
      return this.currentSnapshot;
    }
    if (this.listeners.size > 0) {
      return this.currentSnapshot;
    }
    let retentionAt: number;
    try {
      retentionAt = this.readRetentionNow();
    } catch {
      return this.currentSnapshot;
    }
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
    const recordedAt = this.tryReadRetentionNow('live-update');
    if (recordedAt === null) {
      return;
    }
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

    const recordedAt = this.tryReadRetentionNow(`${feature}-query`);
    if (recordedAt === null) {
      return;
    }
    this.trimExpired(recordedAt);
    this.recordCount(this.queryCountBuckets[feature], this.queryCountBucketMs, recordedAt);
    if (failed === true) {
      this.recordCount(this.failureCountBuckets[feature], this.queryCountBucketMs, recordedAt);
    }
    if (feature === 'token-estimation') {
      this.recordCount(
        this.tokenLookupCountBuckets,
        this.queryCountBucketMs,
        recordedAt,
        lookupCount
      );
      this.recordCount(this.tokenHitCountBuckets, this.queryCountBucketMs, recordedAt, hitCount);
    }
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
      const evictedSample = featureSamples.shift();
      if (!evictedSample) {
        throw new Error('Database query telemetry sample-cap invariant failed');
      }
      this.recordCount(
        this.droppedSampleBuckets[feature],
        this.droppedSampleBucketMs,
        evictedSample.recordedAt
      );
    }
    this.markDirty();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0 && this.retentionClockFailure === null) {
      try {
        const retentionAt = this.readRetentionNow();
        if (this.trimExpired(retentionAt) || this.dirty) {
          this.publishSnapshot(retentionAt);
        }
      } catch {
        // readRetentionNow publishes a stable, explicit failed snapshot.
      }
    }
    this.listeners.add(listener);
    if (this.refreshInterval === null && this.retentionClockFailure === null) {
      this.refreshInterval = setInterval(() => {
        const retentionAt = this.tryReadRetentionNow('refresh-snapshot');
        if (retentionAt === null || !this.trimExpired(retentionAt)) {
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
    const failureCounts = createFeatureArrays(() => 0);
    const queryCounts = createFeatureArrays(() => 0);
    for (const feature of DATABASE_QUERY_FEATURES) {
      droppedSampleCounts[feature] = this.droppedSampleBuckets[feature]
        .filter((bucket) => bucket.startedAt + this.droppedSampleBucketMs > cutoff)
        .reduce((total, bucket) => total + bucket.count, 0);
      queryCounts[feature] = this.queryCountBuckets[feature]
        .filter((bucket) => bucket.startedAt + this.queryCountBucketMs > cutoff)
        .reduce((total, bucket) => total + bucket.count, 0);
      failureCounts[feature] = this.failureCountBuckets[feature]
        .filter((bucket) => bucket.startedAt + this.queryCountBucketMs > cutoff)
        .reduce((total, bucket) => total + bucket.count, 0);
    }
    const lookupCount = this.tokenLookupCountBuckets
      .filter((bucket) => bucket.startedAt + this.queryCountBucketMs > cutoff)
      .reduce((total, bucket) => total + bucket.count, 0);
    const hitCount = this.tokenHitCountBuckets
      .filter((bucket) => bucket.startedAt + this.queryCountBucketMs > cutoff)
      .reduce((total, bucket) => total + bucket.count, 0);

    return {
      activeLiveSubscriptions: this.activeLiveSubscriptions,
      availability: 'active',
      droppedSampleCount: DATABASE_QUERY_FEATURES.reduce(
        (total, feature) => total + droppedSampleCounts[feature],
        0
      ),
      features: {
        'file-tree': featureSnapshot(
          samples['file-tree'],
          this.windowMs,
          droppedSampleCounts['file-tree'],
          queryCounts['file-tree'],
          failureCounts['file-tree']
        ),
        'live-query': featureSnapshot(
          samples['live-query'],
          this.windowMs,
          droppedSampleCounts['live-query'],
          queryCounts['live-query'],
          failureCounts['live-query']
        ),
        'queue-stats': featureSnapshot(
          samples['queue-stats'],
          this.windowMs,
          droppedSampleCounts['queue-stats'],
          queryCounts['queue-stats'],
          failureCounts['queue-stats']
        ),
        'token-estimation': featureSnapshot(
          samples['token-estimation'],
          this.windowMs,
          droppedSampleCounts['token-estimation'],
          queryCounts['token-estimation'],
          failureCounts['token-estimation']
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
      unavailableReason: null,
      windowMs: this.windowMs,
    };
  }

  private markDirty(): void {
    if (this.retentionClockFailure !== null) {
      return;
    }
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
    const retentionAt = this.tryReadRetentionNow('notify-listeners');
    if (retentionAt === null) {
      return;
    }
    this.publishSnapshot(retentionAt);
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
    if (this.retentionClockFailure !== null) {
      throw this.retentionClockFailure;
    }
    try {
      const retentionAt = this.now();
      if (!Number.isFinite(retentionAt) || retentionAt < 0) {
        throw new Error('Database query telemetry monotonic clock must be finite and non-negative');
      }
      return retentionAt;
    } catch (error) {
      throw this.latchRetentionClockFailure(error);
    }
  }

  private tryReadRetentionNow(operation: string): number | null {
    if (this.retentionClockFailure !== null) {
      return null;
    }
    try {
      return this.readRetentionNow();
    } catch (error) {
      logger.error(
        'Database query telemetry retention timing unavailable; samples will not be recorded',
        {
          error: getErrorMessage(error),
          operation,
        }
      );
      for (const listener of this.listeners) {
        listener();
      }
      return null;
    }
  }

  private latchRetentionClockFailure(error: unknown): Error {
    if (this.retentionClockFailure !== null) {
      return this.retentionClockFailure;
    }
    const failure = error instanceof Error ? error : new Error(getErrorMessage(error));
    this.retentionClockFailure = failure;
    if (this.refreshInterval !== null) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    if (this.notifyTimeout !== null) {
      clearTimeout(this.notifyTimeout);
      this.notifyTimeout = null;
    }
    this.currentSnapshot = {
      ...this.currentSnapshot,
      availability: 'failed',
      unavailableReason: failure.message,
    };
    this.dirty = false;
    return failure;
  }

  private readWallNow(): number {
    const snapshotAt = this.wallNow();
    if (!Number.isFinite(snapshotAt)) {
      throw new Error('Database query telemetry wall clock must be finite');
    }
    return snapshotAt;
  }

  private recordCount(
    buckets: CountBucket[],
    bucketMs: number,
    recordedAt: number,
    count = 1
  ): void {
    if (count === 0) {
      return;
    }
    const startedAt = Math.floor(recordedAt / bucketMs) * bucketMs;
    const latestBucket = buckets.at(-1);
    if (!latestBucket || latestBucket.startedAt < startedAt) {
      buckets.push({ count, startedAt });
      return;
    }
    if (latestBucket.startedAt === startedAt) {
      latestBucket.count += count;
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

  private trimExpired(snapshotAt: number): boolean {
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
      changed =
        this.trimCountBuckets(this.queryCountBuckets[feature], this.queryCountBucketMs, cutoff) ||
        changed;
      changed =
        this.trimCountBuckets(this.failureCountBuckets[feature], this.queryCountBucketMs, cutoff) ||
        changed;
    }
    changed =
      this.trimCountBuckets(this.tokenHitCountBuckets, this.queryCountBucketMs, cutoff) || changed;
    changed =
      this.trimCountBuckets(this.tokenLookupCountBuckets, this.queryCountBucketMs, cutoff) ||
      changed;
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
  const startedAt = readQueryMeasurementClock(feature);
  try {
    const result = await work();
    if (startedAt !== null) {
      const completedAt = readQueryMeasurementClock(feature);
      if (completedAt !== null) {
        safelyRecordTelemetry(`${feature}-query`, () => {
          databaseQueryTelemetry.recordQuery({
            durationMs: completedAt - startedAt,
            feature,
            ...(counts
              ? { hitCount: counts.hitCount(result), lookupCount: counts.lookupCount }
              : undefined),
          });
        });
      }
    }
    return result;
  } catch (error) {
    if (startedAt !== null) {
      const completedAt = readQueryMeasurementClock(feature);
      if (completedAt !== null) {
        safelyRecordTelemetry(`${feature}-query-failed`, () => {
          databaseQueryTelemetry.recordQuery({
            durationMs: completedAt - startedAt,
            failed: true,
            feature,
          });
        });
      }
    }
    throw error;
  }
}
