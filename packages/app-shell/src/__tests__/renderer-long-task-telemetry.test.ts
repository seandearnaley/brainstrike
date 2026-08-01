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

  it('disconnects the active observer when telemetry is reset', () => {
    const disconnect = vi.fn();
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      observe(): void {}

      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);

    const telemetry = createRendererLongTaskTelemetry();
    telemetry.observe(() => ({ enabledFeatureFlags: null, route: 'explorer' }));
    telemetry.reset();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'idle',
      sampleCount: 0,
    });
  });

  it('publishes stable external-store snapshots when telemetry changes', () => {
    const telemetry = createRendererLongTaskTelemetry();
    const listener = vi.fn();
    const unsubscribe = telemetry.subscribe(listener);
    const initialSnapshot = telemetry.getSnapshot();

    expect(telemetry.getSnapshot()).toBe(initialSnapshot);

    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: null,
      route: 'settings',
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).not.toBe(initialSnapshot);
    expect(telemetry.getSnapshot()).toMatchObject({
      featureFlagContextAvailability: 'unavailable',
      sampleCount: 1,
    });

    unsubscribe();
    telemetry.record({
      durationMs: 90,
      enabledFeatureFlags: null,
      route: 'settings',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('defers snapshot rebuilding until an unobserved store is read', () => {
    const now = vi.fn(() => 1000);
    const telemetry = createRendererLongTaskTelemetry({ now });

    expect(now).toHaveBeenCalledTimes(1);

    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: [],
      route: 'settings',
    });

    expect(now).toHaveBeenCalledTimes(2);
    expect(telemetry.getSnapshot()).toMatchObject({ sampleCount: 1 });
    expect(now).toHaveBeenCalledTimes(3);
    expect(telemetry.getSnapshot()).toBe(telemetry.getSnapshot());
    expect(now).toHaveBeenCalledTimes(3);
  });

  it('does not let direct samples mask a failed observer', () => {
    class ThrowingPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(_callback: PerformanceObserverCallback) {
        throw new Error('observer construction failed');
      }
    }
    vi.stubGlobal('PerformanceObserver', ThrowingPerformanceObserver);
    const telemetry = createRendererLongTaskTelemetry();
    telemetry.observe(() => ({
      enabledFeatureFlags: [],
      route: 'explorer',
    }));

    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: [],
      route: 'settings',
    });

    expect(telemetry.snapshot()).toMatchObject({
      availability: 'failed',
      sampleCount: 1,
      unavailableReason: 'observer construction failed',
    });
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

  it('treats an empty supported entry type list as explicitly unsupported', () => {
    const observe = vi.fn();
    class UnsupportedPerformanceObserver {
      static readonly supportedEntryTypes: readonly string[] = [];

      observe(): void {
        observe();
      }
    }
    vi.stubGlobal('PerformanceObserver', UnsupportedPerformanceObserver);
    const telemetry = createRendererLongTaskTelemetry();

    telemetry.observe(() => ({
      enabledFeatureFlags: [],
      route: 'explorer',
    }));

    expect(observe).not.toHaveBeenCalled();
    expect(telemetry.snapshot()).toMatchObject({
      availability: 'unsupported',
      unavailableReason: 'This renderer does not support PerformanceObserver longtask entries.',
    });
  });
});
