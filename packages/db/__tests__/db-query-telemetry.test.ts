import { addLogListener, configureLogger, LogLevel, resetLogger } from '@brainstrike/utils/logger';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createDbQueryHistogramAggregator,
  normalizeDbQueryFeatureArea,
  recordDbQueryTelemetry,
} from '../src/db-query-telemetry.js';

describe('db-query-telemetry', () => {
  afterEach(() => {
    resetLogger();
  });

  it('maps scheduler labels to coarse feature areas without retaining SQL or paths', () => {
    expect(normalizeDbQueryFeatureArea('live query refresh')).toBe('live-query');
    expect(normalizeDbQueryFeatureArea('syncToFs')).toBe('sync');
    expect(normalizeDbQueryFeatureArea('transaction')).toBe('transaction');
    expect(normalizeDbQueryFeatureArea('collection indexing stats')).toBe('collection-indexing');
    expect(normalizeDbQueryFeatureArea(null)).toBe('unknown');
    expect(normalizeDbQueryFeatureArea('/Users/test/private/query.sql')).toBe('unknown');

    const serialized = JSON.stringify({
      area: normalizeDbQueryFeatureArea('live query refresh'),
    });
    expect(serialized).not.toContain('/Users/test');
    expect(serialized).not.toContain('.sql');
  });

  it('records only coarse query duration metadata', () => {
    configureLogger({ console: false, level: LogLevel.DEBUG });
    const records: unknown[] = [];
    const unsubscribe = addLogListener((record) => {
      records.push(record);
    });

    try {
      recordDbQueryTelemetry({
        durationMs: 18.5,
        event: 'db.query',
        featureArea: 'live-query',
        priority: 'foreground',
      });
    } finally {
      unsubscribe();
    }

    expect(records).toHaveLength(1);
    const serialized = JSON.stringify(records[0]);
    expect(serialized).toContain('db.query');
    expect(serialized).toContain('live-query');
    expect(serialized).toContain('18.5');
    expect(serialized).not.toContain('SELECT');
  });

  it('aggregates histogram percentiles per feature area', () => {
    const aggregator = createDbQueryHistogramAggregator();
    aggregator.record({
      durationMs: 10,
      event: 'db.query',
      featureArea: 'live-query',
      priority: 'foreground',
    });
    aggregator.record({
      durationMs: 30,
      event: 'db.query',
      featureArea: 'live-query',
      priority: 'foreground',
    });
    aggregator.record({
      durationMs: 50,
      event: 'db.query',
      featureArea: 'live-query',
      priority: 'foreground',
    });
    aggregator.record({
      durationMs: 5,
      event: 'db.query',
      featureArea: 'sync',
      priority: 'background',
    });

    const snapshot = aggregator.snapshot();
    const liveQuery = snapshot.featureAreas.find((entry) => entry.featureArea === 'live-query');
    const sync = snapshot.featureAreas.find((entry) => entry.featureArea === 'sync');

    expect(liveQuery).toMatchObject({
      count: 3,
      durationP50Ms: 30,
      totalDurationMs: 90,
    });
    expect(liveQuery?.durationP95Ms).toBe(50);
    expect(sync).toMatchObject({
      count: 1,
      durationP50Ms: 5,
      durationP95Ms: 5,
      totalDurationMs: 5,
    });
  });
});
