import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DatabaseQueryTelemetry,
  databaseQueryTelemetry,
  measureDatabaseQuery,
} from '../src/database-query-telemetry';

afterEach(() => {
  vi.restoreAllMocks();
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
        'file-tree': { droppedSampleCount: 1, queryCount: 2 },
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
        'file-tree': { droppedSampleCount: 1, queryCount: 2 },
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

  it('keeps rolling count buckets ordered when the wall clock moves backwards', () => {
    let now = 120_000;
    const telemetry = new DatabaseQueryTelemetry({ now: () => now, windowMs: 60_000 });

    telemetry.recordLiveUpdate();
    now = 0;
    telemetry.recordLiveUpdate();
    now = 61_000;

    expect(telemetry.getSnapshot().liveUpdateCount).toBe(1);
    expect(
      (
        telemetry as unknown as {
          readonly liveUpdateBuckets: readonly unknown[];
        }
      ).liveUpdateBuckets
    ).toHaveLength(1);
  });

  it('retains the newest bounded query samples when the wall clock moves backwards', () => {
    let now = 120_000;
    const telemetry = new DatabaseQueryTelemetry({
      maxSamples: 2,
      now: () => now,
      windowMs: 60_000,
    });

    telemetry.recordQuery({ durationMs: 1, feature: 'file-tree' });
    now = 0;
    telemetry.recordQuery({ durationMs: 2, feature: 'file-tree' });
    now = 61_000;
    telemetry.recordQuery({ durationMs: 3, feature: 'file-tree' });

    expect(telemetry.getSnapshot()).toMatchObject({
      droppedSampleCount: 0,
      features: {
        'file-tree': {
          droppedSampleCount: 0,
          durationP95Ms: 3,
          queryCount: 2,
        },
      },
    });
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
    expect(now).toHaveBeenCalledTimes(5);
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
});
