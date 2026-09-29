import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addLogListener } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseQueryTelemetryRecord } from '../src/database-query-telemetry';
import {
  DatabaseQueryTelemetry,
  databaseQueryTelemetry,
  measureDatabaseQuery,
} from '../src/database-query-telemetry';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('DatabaseQueryTelemetry', () => {
  it('keeps bounded rolling query histograms by explicit feature area', () => {
    let now = 1000;
    const telemetry = new DatabaseQueryTelemetry({
      maxSamples: 3,
      now: () => now,
      windowMs: 100,
    });

    telemetry.recordQuery({ durationMs: 10, feature: 'file-tree' });
    now += 20;
    telemetry.recordQuery({ durationMs: 20, feature: 'queue-stats' });
    now += 20;
    telemetry.recordQuery({ durationMs: 30, feature: 'queue-stats' });
    now += 20;
    telemetry.recordQuery({ durationMs: 40, failed: true, feature: 'queue-stats' });

    const snapshot = telemetry.snapshot();
    expect(snapshot.sampleCount).toBe(4);
    expect(snapshot.features['file-tree'].queryCount).toBe(1);
    expect(snapshot.features['queue-stats']).toMatchObject({
      durationP50Ms: 30,
      durationP95Ms: 40,
      failureCount: 1,
      maxDurationMs: 40,
      queryCount: 3,
    });

    now = 1200;
    expect(telemetry.snapshot().sampleCount).toBe(0);
  });

  it('bounds each feature independently and reports retained-sample overflow', () => {
    const telemetry = new DatabaseQueryTelemetry({ maxSamples: 2 });

    telemetry.recordQuery({ durationMs: 1, feature: 'file-tree' });
    telemetry.recordQuery({ durationMs: 2, feature: 'file-tree' });
    telemetry.recordQuery({ durationMs: 3, feature: 'file-tree' });
    telemetry.recordQuery({ durationMs: 4, feature: 'queue-stats' });

    expect(telemetry.snapshot()).toMatchObject({
      droppedSampleCount: 1,
      features: {
        'file-tree': { droppedSampleCount: 1, queryCount: 3 },
        'queue-stats': { droppedSampleCount: 0, queryCount: 1 },
      },
      sampleCount: 3,
    });
  });

  it('expires retained-sample overflow with the rolling query window', () => {
    let now = 1000;
    const telemetry = new DatabaseQueryTelemetry({
      maxSamples: 2,
      now: () => now,
      windowMs: 60_000,
    });

    telemetry.recordQuery({ durationMs: 1, feature: 'file-tree' });
    now += 1;
    telemetry.recordQuery({ durationMs: 2, feature: 'file-tree' });
    now += 1;
    telemetry.recordQuery({ durationMs: 3, feature: 'file-tree' });

    expect(telemetry.snapshot()).toMatchObject({
      droppedSampleCount: 1,
      features: {
        'file-tree': { droppedSampleCount: 1, queryCount: 3 },
      },
    });

    now += 61_001;

    expect(telemetry.snapshot()).toMatchObject({
      droppedSampleCount: 0,
      features: {
        'file-tree': { droppedSampleCount: 0, queryCount: 0 },
      },
    });
  });

  it('tracks live subscriptions and rolling update frequency without query text', () => {
    let now = 2000;
    const telemetry = new DatabaseQueryTelemetry({ now: () => now, windowMs: 1000 });

    telemetry.recordLiveSubscriptionStarted();
    telemetry.recordLiveSubscriptionStarted();
    telemetry.recordLiveUpdate();
    now += 250;
    telemetry.recordLiveUpdate();
    telemetry.recordLiveSubscriptionEnded();

    expect(telemetry.snapshot()).toMatchObject({
      activeLiveSubscriptions: 1,
      liveUpdateCount: 2,
      liveUpdatesPerMinute: 120,
    });
  });

  it('preserves live-update counts above the query sample retention bound', () => {
    let now = 2000;
    const telemetry = new DatabaseQueryTelemetry({ maxSamples: 2, now: () => now });

    for (let update = 0; update < 600; update += 1) {
      telemetry.recordLiveUpdate();
    }

    expect(telemetry.snapshot()).toMatchObject({
      liveUpdateCount: 600,
      liveUpdatesPerMinute: 600,
    });

    now += 61_001;
    expect(telemetry.snapshot().liveUpdateCount).toBe(0);
  });

  it('preserves per-feature query rates above the retained sample bound', () => {
    let now = 2000;
    const telemetry = new DatabaseQueryTelemetry({ maxSamples: 2, now: () => now });

    for (let query = 0; query < 600; query += 1) {
      telemetry.recordQuery({ durationMs: query, feature: 'file-tree' });
    }

    expect(telemetry.snapshot()).toMatchObject({
      droppedSampleCount: 598,
      features: {
        'file-tree': {
          droppedSampleCount: 598,
          queriesPerMinute: 600,
          queryCount: 600,
        },
      },
      sampleCount: 2,
    });

    now += 61_001;
    expect(telemetry.snapshot().features['file-tree']).toMatchObject({
      queriesPerMinute: 0,
      queryCount: 0,
    });
  });

  it('preserves failures above the retained duration-sample bound', () => {
    const telemetry = new DatabaseQueryTelemetry({ maxSamples: 2 });

    telemetry.recordQuery({ durationMs: 1, failed: true, feature: 'file-tree' });
    for (let query = 0; query < 600; query += 1) {
      telemetry.recordQuery({ durationMs: query, feature: 'file-tree' });
    }

    expect(telemetry.snapshot().features['file-tree']).toMatchObject({
      failureCount: 1,
      queryCount: 601,
    });
  });

  it('preserves token lookup and hit totals above the retained duration-sample bound', () => {
    const telemetry = new DatabaseQueryTelemetry({ maxSamples: 2 });

    telemetry.recordQuery({
      durationMs: 1,
      feature: 'token-estimation',
      hitCount: 3,
      lookupCount: 4,
    });
    for (let query = 0; query < 10; query += 1) {
      telemetry.recordQuery({ durationMs: query, feature: 'token-estimation' });
    }

    expect(telemetry.snapshot().tokenEstimation).toEqual({
      cacheHitRate: 3 / 4,
      hitCount: 3,
      lookupCount: 4,
    });
  });

  it('expires exact failure and token totals with their rolling buckets', () => {
    let now = 0;
    const telemetry = new DatabaseQueryTelemetry({ now: () => now, windowMs: 1000 });

    telemetry.recordQuery({
      durationMs: 1,
      failed: true,
      feature: 'token-estimation',
      hitCount: 3,
      lookupCount: 4,
    });
    now = 1017;

    expect(telemetry.snapshot()).toMatchObject({
      features: {
        'token-estimation': {
          failureCount: 0,
          queryCount: 0,
        },
      },
      tokenEstimation: {
        cacheHitRate: null,
        hitCount: 0,
        lookupCount: 0,
      },
    });
  });

  it('uses sub-window buckets so expired query arrivals do not over-report', () => {
    let now = 0;
    const telemetry = new DatabaseQueryTelemetry({
      maxSamples: 1,
      now: () => now,
      windowMs: 1000,
    });

    telemetry.recordQuery({ durationMs: 1, feature: 'queue-stats' });
    now = 999;
    telemetry.recordQuery({ durationMs: 2, feature: 'queue-stats' });
    now = 1017;

    expect(telemetry.getSnapshot().features['queue-stats']).toMatchObject({
      queriesPerMinute: 60,
      queryCount: 1,
    });
  });

  it('expires overflow when the evicted sample leaves the rolling window', () => {
    let now = 0;
    const telemetry = new DatabaseQueryTelemetry({
      maxSamples: 1,
      now: () => now,
      windowMs: 1000,
    });

    telemetry.recordQuery({ durationMs: 1, feature: 'file-tree' });
    now = 999;
    telemetry.recordQuery({ durationMs: 2, feature: 'file-tree' });
    now = 1017;

    expect(telemetry.getSnapshot()).toMatchObject({
      droppedSampleCount: 0,
      features: {
        'file-tree': {
          droppedSampleCount: 0,
          queryCount: 1,
        },
      },
      sampleCount: 1,
    });
  });

  it('expires query samples on monotonic time when the wall clock moves backwards', () => {
    let monotonicNow = 1000;
    let wallNow = 120_000;

    const telemetry = new DatabaseQueryTelemetry({
      now: () => monotonicNow,
      wallNow: () => wallNow,
      windowMs: 60_000,
    });

    telemetry.recordQuery({ durationMs: 1, feature: 'file-tree' });
    wallNow = 0;
    monotonicNow += 60_001;

    expect(telemetry.getSnapshot()).toMatchObject({
      sampleCount: 0,
      snapshotAt: 0,
    });
  });

  it('uses sub-window buckets so expired live updates do not over-report', () => {
    let now = 0;
    const telemetry = new DatabaseQueryTelemetry({ now: () => now, windowMs: 1000 });

    telemetry.recordLiveUpdate();
    now = 999;
    telemetry.recordLiveUpdate();
    now = 1017;

    expect(telemetry.getSnapshot().liveUpdateCount).toBe(1);
  });

  it('evicts the oldest arrival when a full query buffer receives a new sample', () => {
    let now = 1000;
    const telemetry = new DatabaseQueryTelemetry({
      maxSamples: 2,
      now: () => now,
      windowMs: 60_000,
    });

    telemetry.recordQuery({ durationMs: 1, feature: 'file-tree' });
    now += 1;
    telemetry.recordQuery({ durationMs: 2, feature: 'file-tree' });
    now += 1;
    telemetry.recordQuery({ durationMs: 3, feature: 'file-tree' });

    expect(telemetry.getSnapshot()).toMatchObject({
      droppedSampleCount: 1,
      features: {
        'file-tree': {
          droppedSampleCount: 1,
          durationP50Ms: 2,
          durationP95Ms: 3,
          queryCount: 3,
        },
      },
    });
  });

  it('rejects malformed or extra runtime fields before retaining a sample', () => {
    const telemetry = new DatabaseQueryTelemetry();

    expect(() =>
      telemetry.recordQuery({
        durationMs: 1,
        feature: 'file-tree',
        sql: 'SELECT secret',
      } as unknown as DatabaseQueryTelemetryRecord)
    ).toThrow('Database query telemetry record contains unsupported field: sql');
    expect(() =>
      telemetry.recordQuery({
        durationMs: 1,
        failed: 'yes',
        feature: 'file-tree',
      } as unknown as DatabaseQueryTelemetryRecord)
    ).toThrow('Database query telemetry failed must be a boolean when provided');
    expect(() =>
      telemetry.recordQuery({
        durationMs: 1,
        feature: 'workspace-private',
      } as unknown as DatabaseQueryTelemetryRecord)
    ).toThrow('Database query telemetry feature is unsupported: workspace-private');
    expect(telemetry.getSnapshot().sampleCount).toBe(0);
  });

  it('captures caller-supplied fields once before validation and retention', () => {
    const telemetry = new DatabaseQueryTelemetry();
    let failedReads = 0;
    const record = {
      durationMs: 1,
      get failed(): boolean | string {
        failedReads += 1;
        return failedReads === 1 ? true : 'yes';
      },
      feature: 'file-tree',
    } as unknown as DatabaseQueryTelemetryRecord;

    telemetry.recordQuery(record);

    expect(failedReads).toBe(1);
    expect(telemetry.getSnapshot().features['file-tree'].failureCount).toBe(1);
  });

  it('does not read the monotonic clock while importing the database package', () => {
    // Vitest 5 uses performance.now while importing modules. Isolate the absent
    // global in a native process while still resolving workspace source.
    expect(() =>
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('./fixtures/telemetry-import-without-clock.mjs', import.meta.url)),
        ],
        {
          cwd: new URL('../', import.meta.url),
          stdio: ['ignore', 'pipe', 'inherit'],
          timeout: 10_000,
        }
      )
    ).not.toThrow();
  });

  it('aggregates token-estimation cache hits from lookup counts', () => {
    const telemetry = new DatabaseQueryTelemetry();

    telemetry.recordQuery({
      durationMs: 4,
      feature: 'token-estimation',
      hitCount: 3,
      lookupCount: 4,
    });
    telemetry.recordQuery({
      durationMs: 2,
      feature: 'token-estimation',
      hitCount: 1,
      lookupCount: 2,
    });

    expect(telemetry.snapshot().tokenEstimation).toEqual({
      cacheHitRate: 4 / 6,
      hitCount: 4,
      lookupCount: 6,
    });
  });

  it('coalesces external-store notifications without rebuilding snapshots on record', async () => {
    vi.useFakeTimers();
    const now = vi.fn(() => 3000);
    const telemetry = new DatabaseQueryTelemetry({ now });
    const listener = vi.fn();
    const unsubscribe = telemetry.subscribe(listener);
    const initialSnapshot = telemetry.getSnapshot();

    expect(telemetry.getSnapshot()).toBe(initialSnapshot);

    telemetry.recordQuery({ durationMs: 7, feature: 'file-tree' });
    telemetry.recordLiveSubscriptionStarted();
    telemetry.recordLiveUpdate();
    telemetry.recordLiveSubscriptionEnded();

    expect(listener).not.toHaveBeenCalled();
    expect(telemetry.getSnapshot()).toBe(initialSnapshot);
    expect(now).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).not.toBe(initialSnapshot);
    expect(telemetry.getSnapshot()).toMatchObject({
      activeLiveSubscriptions: 0,
      liveUpdateCount: 1,
      sampleCount: 1,
    });

    unsubscribe();
    telemetry.recordQuery({ durationMs: 8, feature: 'file-tree' });
    const callsAfterUnsubscribedRecord = now.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(now).toHaveBeenCalledTimes(callsAfterUnsubscribedRecord);
  });

  it('does not expose a reset that can invalidate active subscription ownership', () => {
    const telemetry = new DatabaseQueryTelemetry();

    expect('reset' in telemetry).toBe(false);
  });

  it('uses a monotonic duration clock when the wall clock moves backwards', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(2000).mockReturnValueOnce(1000);
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(25);
    const recordQuery = vi.spyOn(databaseQueryTelemetry, 'recordQuery');

    await expect(measureDatabaseQuery('queue-stats', async () => 'ok')).resolves.toBe('ok');

    expect(recordQuery).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 15, feature: 'queue-stats' })
    );
  });

  it('records attempted token lookups with zero hits when a measured query fails', async () => {
    const queryError = new Error('query failed');
    const recordQuery = vi.spyOn(databaseQueryTelemetry, 'recordQuery');

    await expect(
      measureDatabaseQuery(
        'token-estimation',
        async () => {
          throw queryError;
        },
        { hitCount: () => 3, lookupCount: 3 }
      )
    ).rejects.toBe(queryError);

    expect(recordQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        failed: true,
        feature: 'token-estimation',
        hitCount: 0,
        lookupCount: 3,
      })
    );
  });

  it('never changes successful query results when telemetry collection fails', async () => {
    vi.spyOn(databaseQueryTelemetry, 'recordQuery').mockImplementation(() => {
      throw new Error('telemetry unavailable');
    });

    await expect(
      measureDatabaseQuery('token-estimation', async () => 'result', {
        hitCount: () => 1,
        lookupCount: 1,
      })
    ).resolves.toBe('result');
  });

  it('runs every database operation but probes a failed measurement clock once', async () => {
    const now = vi.fn(() => {
      throw new Error('measurement clock unavailable');
    });
    vi.stubGlobal('performance', { now });
    const work = vi.fn(async () => 'query result');
    const recordQuery = vi.spyOn(databaseQueryTelemetry, 'recordQuery');

    await expect(measureDatabaseQuery('file-tree', work)).resolves.toBe('query result');
    await expect(measureDatabaseQuery('queue-stats', work)).resolves.toBe('query result');

    expect(work).toHaveBeenCalledTimes(2);
    expect(now).toHaveBeenCalledTimes(1);
    expect(recordQuery).not.toHaveBeenCalled();
  });

  it('latches a failed retention clock across live updates and subscriber timers', async () => {
    vi.useFakeTimers();
    let clockAvailable = true;
    const now = vi.fn(() => {
      if (!clockAvailable) {
        throw new Error('retention clock unavailable');
      }
      return 1000;
    });
    const telemetry = new DatabaseQueryTelemetry({ now });
    const listener = vi.fn();
    const telemetryErrors: string[] = [];
    const removeLogListener = addLogListener((record) => {
      if (record.scope === 'DatabaseQueryTelemetry' && record.level === 'error') {
        telemetryErrors.push(record.message ?? '');
      }
    });
    const unsubscribe = telemetry.subscribe(listener);
    telemetry.recordQuery({
      durationMs: 12,
      failed: true,
      feature: 'queue-stats',
    });
    telemetry.recordLiveSubscriptionStarted();
    telemetry.recordLiveUpdate();
    expect(telemetry.snapshot()).toMatchObject({
      activeLiveSubscriptions: 1,
      features: {
        'queue-stats': { failureCount: 1, queryCount: 1 },
      },
      liveUpdateCount: 1,
      sampleCount: 1,
    });
    clockAvailable = false;

    try {
      telemetry.recordLiveUpdate();
      const clockCallsAfterFailure = now.mock.calls.length;
      telemetry.recordLiveUpdate();
      telemetry.recordLiveUpdate();
      await vi.advanceTimersByTimeAsync(3000);
      telemetry.recordLiveSubscriptionEnded();
      await vi.advanceTimersByTimeAsync(1000);

      expect(now).toHaveBeenCalledTimes(clockCallsAfterFailure);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(telemetryErrors).toEqual([
        'Database query telemetry retention timing unavailable; samples will not be recorded',
      ]);
      expect(telemetry.getSnapshot()).toMatchObject({
        activeLiveSubscriptions: 0,
        availability: 'failed',
        droppedSampleCount: 0,
        features: {
          'file-tree': { failureCount: 0, queryCount: 0 },
          'live-query': { failureCount: 0, queryCount: 0 },
          'queue-stats': { failureCount: 0, queryCount: 0 },
          'token-estimation': { failureCount: 0, queryCount: 0 },
        },
        liveUpdateCount: 0,
        liveUpdatesPerMinute: 0,
        sampleCount: 0,
        tokenEstimation: {
          cacheHitRate: null,
          hitCount: 0,
          lookupCount: 0,
        },
        unavailableReason: 'retention clock unavailable',
      });
      const failedSnapshot = telemetry.getSnapshot();
      expect(telemetry.getSnapshot()).toBe(failedSnapshot);
    } finally {
      unsubscribe();
      removeLogListener();
    }

    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      unavailableReason: 'retention clock unavailable',
    });
    expect(() => telemetry.snapshot()).toThrow('retention clock unavailable');
  });

  it('returns an unsubscribe handle when the first external-store read fails', () => {
    const telemetry = new DatabaseQueryTelemetry({
      now: () => {
        throw new Error('initial retention clock unavailable');
      },
    });
    const listener = vi.fn();

    expect(() => {
      const unsubscribe = telemetry.subscribe(listener);
      expect(telemetry.getSnapshot()).toMatchObject({
        availability: 'failed',
        unavailableReason: 'initial retention clock unavailable',
      });
      unsubscribe();
    }).not.toThrow();
  });

  it('latches a non-finite measurement clock while preserving every operation', async () => {
    const now = vi.fn(() => Number.NaN);
    vi.stubGlobal('performance', { now });
    const work = vi.fn(async () => 'query result');
    const recordQuery = vi.spyOn(databaseQueryTelemetry, 'recordQuery');

    await expect(measureDatabaseQuery('file-tree', work)).resolves.toBe('query result');
    await expect(measureDatabaseQuery('queue-stats', work)).resolves.toBe('query result');

    expect(work).toHaveBeenCalledTimes(2);
    expect(now).toHaveBeenCalledTimes(1);
    expect(recordQuery).not.toHaveBeenCalled();
  });

  it('stops producer records after a retention failure without repeated error logs', async () => {
    vi.resetModules();
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(Number.NaN)
      .mockReturnValueOnce(30)
      .mockReturnValueOnce(40);
    vi.stubGlobal('performance', { now });
    const [{ addLogListener: addFreshLogListener }, telemetryModule] = await Promise.all([
      import('@brainstrike/logging'),
      import('../src/database-query-telemetry'),
    ]);
    const telemetryErrors: string[] = [];
    const removeLogListener = addFreshLogListener((record) => {
      if (record.scope === 'DatabaseQueryTelemetry' && record.level === 'error') {
        telemetryErrors.push(record.message ?? '');
      }
    });
    const work = vi.fn(async () => 'query result');

    try {
      await expect(telemetryModule.measureDatabaseQuery('file-tree', work)).resolves.toBe(
        'query result'
      );
      await expect(telemetryModule.measureDatabaseQuery('queue-stats', work)).resolves.toBe(
        'query result'
      );

      expect(work).toHaveBeenCalledTimes(2);
      expect(now).toHaveBeenCalledTimes(5);
      expect(telemetryErrors).toEqual([
        'Database query telemetry retention timing unavailable; samples will not be recorded',
      ]);
      expect(telemetryModule.databaseQueryTelemetry.getSnapshot()).toMatchObject({
        availability: 'failed',
        unavailableReason:
          'Database query telemetry monotonic clock must be finite and non-negative',
      });
      expect(() => telemetryModule.databaseQueryTelemetry.snapshot()).toThrow(
        'Database query telemetry monotonic clock must be finite and non-negative'
      );
    } finally {
      removeLogListener();
    }
  });
});
