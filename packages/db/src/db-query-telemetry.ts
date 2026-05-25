import { createLogger } from '@brainstrike/utils/logger';
import type { DatabaseWorkPriority } from './database-work-scheduler.js';

const logger = createLogger('DbQueryTelemetry');

export type DbQueryFeatureArea =
  | 'collection-indexing'
  | 'live-query'
  | 'sync'
  | 'transaction'
  | 'unknown';

export interface DbQueryTelemetryMetric {
  durationMs: number;
  event: 'db.query';
  featureArea: DbQueryFeatureArea;
  priority: DatabaseWorkPriority;
}

export interface DbQueryFeatureHistogram {
  count: number;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
  featureArea: DbQueryFeatureArea;
  totalDurationMs: number;
}

export interface DbQueryHistogramSnapshot {
  featureAreas: readonly DbQueryFeatureHistogram[];
  snapshotAt: number;
}

const FEATURE_AREA_BY_LABEL: Readonly<Record<string, DbQueryFeatureArea>> = {
  'live query refresh': 'live-query',
  syncToFs: 'sync',
  transaction: 'transaction',
};

function computePercentile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(percentile * sorted.length));
  return sorted[index] ?? null;
}

export function normalizeDbQueryFeatureArea(label: string | null): DbQueryFeatureArea {
  if (!label) {
    return 'unknown';
  }
  const direct = FEATURE_AREA_BY_LABEL[label];
  if (direct) {
    return direct;
  }
  const normalized = label.toLowerCase();
  if (normalized.includes('index')) {
    return 'collection-indexing';
  }
  return 'unknown';
}

export function recordDbQueryTelemetry(metric: DbQueryTelemetryMetric): void {
  logger.debug('DB query telemetry', metric);
}

export function createDbQueryHistogramAggregator(windowMs = 60_000, maxSamples = 512) {
  const samplesByFeature = new Map<DbQueryFeatureArea, number[]>();
  let snapshotAt = Date.now();

  const record = (metric: DbQueryTelemetryMetric, now = Date.now()): void => {
    snapshotAt = now;
    const samples = samplesByFeature.get(metric.featureArea) ?? [];
    samples.push(metric.durationMs);
    while (samples.length > maxSamples) {
      samples.shift();
    }
    samplesByFeature.set(metric.featureArea, samples);
  };

  const snapshot = (now = Date.now()): DbQueryHistogramSnapshot => {
    snapshotAt = now;
    const featureAreas: DbQueryFeatureHistogram[] = [];
    for (const [featureArea, samples] of samplesByFeature.entries()) {
      featureAreas.push({
        count: samples.length,
        durationP50Ms: computePercentile(samples, 0.5),
        durationP95Ms: computePercentile(samples, 0.95),
        featureArea,
        totalDurationMs: samples.reduce((sum, value) => sum + value, 0),
      });
    }
    featureAreas.sort((left, right) => left.featureArea.localeCompare(right.featureArea));
    return {
      featureAreas,
      snapshotAt,
    };
  };

  return {
    record,
    snapshot,
    windowMs,
  };
}
