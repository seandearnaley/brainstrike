import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRendererLongTaskTelemetry,
  type RendererLongTaskContext,
} from '../diagnostics/renderer-long-task-telemetry';

describe('renderer-long-task-telemetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('aggregates a bounded rolling window by coarse route and surface', () => {
    let now = 1000;
    const telemetry = createRendererLongTaskTelemetry({
      maxSamples: 3,
      now: () => now,
      windowMs: 1000,
    });

    telemetry.record({
      durationMs: 60,
      enabledFeatureFlags: ['semantic-search'],
      route: 'explorer',
    });
    now += 100;
    telemetry.record({
      durationMs: 80,
      enabledFeatureFlags: ['semantic-search'],
      route: 'settings',
    });
    now += 100;
    telemetry.record({
      durationMs: 100,
      enabledFeatureFlags: [],
      route: 'explorer',
    });
    now += 100;
    telemetry.record({
      durationMs: 120,
      enabledFeatureFlags: ['terminal-profiles'],
      route: 'terminal',
    });

    expect(telemetry.snapshot()).toMatchObject({
      availability: 'idle',
      durationP50Ms: 100,
      durationP95Ms: 120,
      featureFlags: [
        { count: 1, flag: 'semantic-search' },
        { count: 1, flag: 'terminal-profiles' },
      ],
      maxDurationMs: 120,
      routes: [
        { count: 1, route: 'explorer' },
        { count: 1, route: 'settings' },
        { count: 1, route: 'terminal' },
      ],
      sampleCount: 3,
    });

    now += 1001;
    expect(telemetry.snapshot()).toMatchObject({
      durationP50Ms: null,
      durationP95Ms: null,
      featureFlags: [],
      maxDurationMs: null,
      routes: [],
      sampleCount: 0,
    });
  });

  it('observes only longtask entries and reads fresh context for every delivery', () => {
    const callbacks: PerformanceObserverCallback[] = [];
    const disconnect = vi.fn();
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(nextCallback: PerformanceObserverCallback) {
        callbacks.push(nextCallback);
      }

      observe(): void {}

      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);

    let context: RendererLongTaskContext = {
      enabledFeatureFlags: [],
      route: 'explorer',
    };
    const telemetry = createRendererLongTaskTelemetry();
    const dispose = telemetry.observe(() => context);

    context = {
      enabledFeatureFlags: ['settings-redesign'],
      route: 'settings',
    };
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }
    callback(
      {
        getEntries: () => [
          { duration: 49, entryType: 'longtask' } as PerformanceEntry,
          { duration: 75, entryType: 'paint' } as PerformanceEntry,
          { duration: 90, entryType: 'longtask' } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(telemetry.snapshot()).toMatchObject({
      availability: 'active',
      featureFlags: [{ count: 1, flag: 'settings-redesign' }],
      routes: [{ count: 1, route: 'settings' }],
      sampleCount: 1,
    });

    dispose();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('surfaces unsupported and failed observer states instead of silently degrading', () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    const unsupported = createRendererLongTaskTelemetry();
    unsupported.observe(() => ({
      enabledFeatureFlags: [],
      route: 'explorer',
    }));
    expect(unsupported.snapshot()).toMatchObject({
      availability: 'unsupported',
      unavailableReason: 'PerformanceObserver is unavailable in this renderer.',
    });

    class ThrowingPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(_callback: PerformanceObserverCallback) {
        throw new Error('observer construction failed');
      }
    }
    vi.stubGlobal('PerformanceObserver', ThrowingPerformanceObserver);
    const failed = createRendererLongTaskTelemetry();
    failed.observe(() => ({
      enabledFeatureFlags: [],
      route: 'explorer',
    }));
    expect(failed.snapshot()).toMatchObject({
      availability: 'failed',
      unavailableReason: 'observer construction failed',
    });
  });
});
