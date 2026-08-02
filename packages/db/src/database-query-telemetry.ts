import { createLogger } from '@brainstrike/utils';

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

interface QuerySample extends DatabaseQueryTelemetryRecord {
  readonly recordedAt: number;
  readonly sequence: number;
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

export class DatabaseQueryTelemetry {
  private activeLiveSubscriptions = 0;
  private currentSnapshot: DatabaseQueryTelemetrySnapshot;
  private dirty = false;
  private readonly droppedSampleBucketMs: number;
  private readonly droppedSampleBuckets = createFeatureArrays<CountBucket[]>(() => []);
  private readonly liveUpdateBucketMs: number;
  private readonly liveUpdateBuckets: CountBucket[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly maxSamples: number;
  private nextQuerySequence = 0;
  private readonly now: () => number;
  private notifyTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly querySamples = createFeatureArrays<QuerySample[]>(() => []);
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly windowMs: number;

  constructor(options: DatabaseQueryTelemetryOptions = {}) {
    this.maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES_PER_FEATURE;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.droppedSampleBucketMs = Math.max(
      1,
      Math.min(NOTIFY_INTERVAL_MS, Math.floor(this.windowMs / 60))
    );
    this.liveUpdateBucketMs = Math.min(NOTIFY_INTERVAL_MS, this.windowMs);
    this.now = options.now ?? Date.now;
    assertPositiveInteger(this.maxSamples, 'Database query telemetry maxSamples');
    assertPositiveInteger(this.windowMs, 'Database query telemetry windowMs');
    this.currentSnapshot = this.snapshot();
  }

  readonly getSnapshot = (): DatabaseQueryTelemetrySnapshot => {
    if (this.trimExpired()) {
      this.dirty = true;
    }
    if (this.dirty) {
      this.currentSnapshot = this.snapshot();
      this.dirty = false;
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
    const recordedAt = this.now();
    this.recordCount(this.liveUpdateBuckets, this.liveUpdateBucketMs, recordedAt);
    this.trimCountBuckets(
      this.liveUpdateBuckets,
      this.liveUpdateBucketMs,
      recordedAt - this.windowMs
    );
    this.markDirty();
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

    const recordedAt = this.now();
    this.trimExpired(recordedAt);
    const featureSamples = this.querySamples[record.feature];
    this.insertQuerySample(featureSamples, {
      ...record,
      hitCount,
      lookupCount,
      recordedAt,
      sequence: this.nextQuerySequence,
    });
    this.nextQuerySequence += 1;
    if (featureSamples.length > this.maxSamples) {
      this.evictOldestArrival(featureSamples);
      this.recordCount(
        this.droppedSampleBuckets[record.feature],
        this.droppedSampleBucketMs,
        recordedAt
      );
    }
    this.markDirty();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
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
    const snapshotAt = this.now();
    const cutoff = snapshotAt - this.windowMs;
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
      snapshotAt,
      tokenEstimation: {
        cacheHitRate: lookupCount === 0 ? null : hitCount / lookupCount,
        hitCount,
        lookupCount,
      },
      windowMs: this.windowMs,
    };
  }

  private insertQuerySample(samples: QuerySample[], sample: QuerySample): void {
    const latestSample = samples.at(-1);
    if (!latestSample || latestSample.recordedAt <= sample.recordedAt) {
      samples.push(sample);
      return;
    }

    let lowerBound = 0;
    let upperBound = samples.length;
    while (lowerBound < upperBound) {
      const middle = Math.floor((lowerBound + upperBound) / 2);
      const middleSample = samples[middle];
      if (!middleSample) {
        throw new Error('Database query telemetry sample ordering invariant failed');
      }
      if (middleSample.recordedAt <= sample.recordedAt) {
        lowerBound = middle + 1;
      } else {
        upperBound = middle;
      }
    }
    samples.splice(lowerBound, 0, sample);
  }

  private evictOldestArrival(samples: QuerySample[]): void {
    let oldestIndex = 0;
    for (let index = 1; index < samples.length; index += 1) {
      const candidate = samples[index];
      const oldest = samples[oldestIndex];
      if (!(candidate && oldest)) {
        throw new Error('Database query telemetry arrival ordering invariant failed');
      }
      if (candidate.sequence < oldest.sequence) {
        oldestIndex = index;
      }
    }
    samples.splice(oldestIndex, 1);
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
    this.getSnapshot();
    for (const listener of this.listeners) {
      listener();
    }
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

    let lowerBound = 0;
    let upperBound = buckets.length;
    while (lowerBound < upperBound) {
      const middle = Math.floor((lowerBound + upperBound) / 2);
      const middleBucket = buckets[middle];
      if (!middleBucket) {
        throw new Error('Database query telemetry count-bucket ordering invariant failed');
      }
      if (middleBucket.startedAt < startedAt) {
        lowerBound = middle + 1;
      } else {
        upperBound = middle;
      }
    }
    const matchingBucket = buckets[lowerBound];
    if (matchingBucket?.startedAt === startedAt) {
      matchingBucket.count += 1;
      return;
    }
    buckets.splice(lowerBound, 0, { count: 1, startedAt });
  }

  private trimCountBuckets(buckets: CountBucket[], bucketMs: number, cutoff: number): boolean {
    let changed = false;
    while ((buckets[0]?.startedAt ?? cutoff) + bucketMs <= cutoff) {
      buckets.shift();
      changed = true;
    }
    return changed;
  }

  private trimExpired(snapshotAt = this.now()): boolean {
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
  const startedAt = performance.now();
  try {
    const result = await work();
    safelyRecordTelemetry(`${feature}-query`, () => {
      databaseQueryTelemetry.recordQuery({
        durationMs: performance.now() - startedAt,
        feature,
        ...(counts
          ? { hitCount: counts.hitCount(result), lookupCount: counts.lookupCount }
          : undefined),
      });
    });
    return result;
  } catch (error) {
    safelyRecordTelemetry(`${feature}-query-failed`, () => {
      databaseQueryTelemetry.recordQuery({
        durationMs: performance.now() - startedAt,
        failed: true,
        feature,
      });
    });
    throw error;
  }
}
