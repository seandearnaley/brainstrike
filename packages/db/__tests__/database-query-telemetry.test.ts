import { describe, expect, it } from 'vitest';
import { DatabaseQueryTelemetry } from '../src/database-query-telemetry';

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
    expect(snapshot.sampleCount).toBe(3);
    expect(snapshot.features['file-tree'].queryCount).toBe(0);
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
});
