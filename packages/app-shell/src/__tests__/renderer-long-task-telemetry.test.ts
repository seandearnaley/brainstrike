import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRendererLongTaskTelemetry,
  type RendererLongTaskContext,
} from '../diagnostics/renderer-long-task-telemetry';

describe('renderer-long-task-telemetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
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

    expect(telemetry.getSnapshot()).toMatchObject({
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
    vi.advanceTimersByTime(1001);
    expect(telemetry.getSnapshot()).toMatchObject({
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
    const observe = vi.fn();
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(nextCallback: PerformanceObserverCallback) {
        callbacks.push(nextCallback);
      }

      observe(options: PerformanceObserverInit): void {
        observe(options);
      }

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

    expect(observe).toHaveBeenCalledWith({ buffered: true, type: 'longtask' });

    context = {
      enabledFeatureFlags: ['settings-redesign'],
      route: 'settings',
    };
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }
    const entryStartTime = Date.now() - performance.timeOrigin;
    callback(
      {
        getEntries: () => [
          { duration: 49, entryType: 'longtask', startTime: entryStartTime } as PerformanceEntry,
          { duration: 75, entryType: 'paint', startTime: entryStartTime } as PerformanceEntry,
          { duration: 90, entryType: 'longtask', startTime: entryStartTime } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'active',
      featureFlags: [{ count: 1, flag: 'settings-redesign' }],
      routes: [{ count: 1, route: 'settings' }],
      sampleCount: 1,
    });

    dispose();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('publishes feature-source availability changes before another long task arrives', () => {
    const telemetry = createRendererLongTaskTelemetry();
    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: null,
      route: 'explorer',
    });
    const listener = vi.fn();
    const unsubscribe = telemetry.subscribe(listener);

    telemetry.updateContext({
      enabledFeatureFlags: ['diagnostics-v2'],
      route: 'explorer',
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).toMatchObject({
      featureFlagContextAvailability: 'unavailable',
      sampleCount: 1,
    });

    telemetry.record({
      durationMs: 80,
      enabledFeatureFlags: ['diagnostics-v2'],
      route: 'explorer',
    });
    expect(telemetry.getSnapshot()).toMatchObject({
      featureFlagContextAvailability: 'mixed',
      sampleCount: 2,
    });

    unsubscribe();
  });

  it('keeps current feature-source ownership in updateContext after samples expire', () => {
    const telemetry = createRendererLongTaskTelemetry({ windowMs: 100 });
    telemetry.updateContext({
      enabledFeatureFlags: null,
      route: 'explorer',
    });
    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: ['diagnostics-v2'],
      route: 'settings',
    });

    expect(telemetry.getSnapshot()).toMatchObject({
      featureFlagContextAvailability: 'available',
      sampleCount: 1,
    });

    vi.advanceTimersByTime(101);

    expect(telemetry.getSnapshot()).toMatchObject({
      featureFlagContextAvailability: 'unavailable',
      sampleCount: 0,
    });
    expect('snapshot' in telemetry).toBe(false);
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

  it('expires retained samples even without diagnostics subscribers', () => {
    const now = vi.fn(() => Date.now());
    const telemetry = createRendererLongTaskTelemetry({
      now,
      windowMs: 1000,
    });
    const unsubscribe = telemetry.subscribe(vi.fn());

    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: ['private-preview'],
      route: 'settings',
    });

    expect(vi.getTimerCount()).toBe(1);
    const populatedSnapshot = telemetry.getSnapshot();
    expect(populatedSnapshot.featureFlags).toEqual([{ count: 1, flag: 'private-preview' }]);
    unsubscribe();

    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1001);

    const nowCallsAfterExpiry = now.mock.calls.length;
    const expiredSnapshot = telemetry.getSnapshot();
    expect(expiredSnapshot).not.toBe(populatedSnapshot);
    expect(expiredSnapshot).toMatchObject({
      featureFlags: [],
      routes: [],
      sampleCount: 0,
    });
    expect(now).toHaveBeenCalledTimes(nowCallsAfterExpiry + 1);
    const nowCallsAfterRead = now.mock.calls.length;
    expect(telemetry.getSnapshot()).toBe(expiredSnapshot);
    expect(now).toHaveBeenCalledTimes(nowCallsAfterRead);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears cached identifiers immediately when reset without diagnostics subscribers', () => {
    const now = vi.fn(() => 1000);
    const telemetry = createRendererLongTaskTelemetry({ now });

    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: ['private-preview'],
      route: 'settings',
    });

    const populatedSnapshot = telemetry.getSnapshot();
    expect(populatedSnapshot).toMatchObject({
      featureFlags: [{ count: 1, flag: 'private-preview' }],
      routes: [{ count: 1, route: 'settings' }],
      sampleCount: 1,
    });

    const nowCallsBeforeReset = now.mock.calls.length;
    telemetry.reset();

    expect(now).toHaveBeenCalledTimes(nowCallsBeforeReset + 1);
    const nowCallsAfterReset = now.mock.calls.length;
    const resetSnapshot = telemetry.getSnapshot();
    expect(resetSnapshot).not.toBe(populatedSnapshot);
    expect(resetSnapshot).toMatchObject({
      featureFlags: [],
      routes: [],
      sampleCount: 0,
    });
    expect(now).toHaveBeenCalledTimes(nowCallsAfterReset);
  });

  it('clears capped identifiers from the cache before an unobserved store is read', () => {
    const now = vi.fn(() => 1000);
    const telemetry = createRendererLongTaskTelemetry({ maxSamples: 1, now });
    const unsubscribe = telemetry.subscribe(vi.fn());

    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: ['private-preview'],
      route: 'settings',
    });
    const populatedSnapshot = telemetry.getSnapshot();
    unsubscribe();

    telemetry.record({
      durationMs: 90,
      enabledFeatureFlags: ['terminal-preview'],
      route: 'terminal',
    });

    const nowCallsBeforeRead = now.mock.calls.length;
    const cappedSnapshot = telemetry.getSnapshot();
    expect(cappedSnapshot).not.toBe(populatedSnapshot);
    expect(cappedSnapshot).toMatchObject({
      featureFlags: [{ count: 1, flag: 'terminal-preview' }],
      routes: [{ count: 1, route: 'terminal' }],
      sampleCount: 1,
    });
    expect(now).toHaveBeenCalledTimes(nowCallsBeforeRead + 1);
    const nowCallsAfterRead = now.mock.calls.length;
    expect(telemetry.getSnapshot()).toBe(cappedSnapshot);
    expect(now).toHaveBeenCalledTimes(nowCallsAfterRead);
  });

  it('scrubs identifiers when record-time pruning beats an overdue retention timer', () => {
    let currentTime = 1000;
    const now = vi.fn(() => currentTime);
    const telemetry = createRendererLongTaskTelemetry({ now, windowMs: 100 });
    const unsubscribe = telemetry.subscribe(vi.fn());

    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: ['private-preview'],
      route: 'settings',
    });
    const populatedSnapshot = telemetry.getSnapshot();
    unsubscribe();

    currentTime = 1101;
    telemetry.record({
      durationMs: 90,
      enabledFeatureFlags: ['terminal-preview'],
      route: 'terminal',
    });

    const prunedSnapshot = telemetry.getSnapshot();
    expect(prunedSnapshot).not.toBe(populatedSnapshot);
    expect(prunedSnapshot).toMatchObject({
      featureFlags: [{ count: 1, flag: 'terminal-preview' }],
      routes: [{ count: 1, route: 'terminal' }],
      sampleCount: 1,
    });
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

    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      sampleCount: 1,
      unavailableReason: 'observer construction failed',
    });
  });

  it('surfaces unsupported and failed observer states instead of silently degrading', () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    const unsupported = createRendererLongTaskTelemetry();
    const disposeUnsupported = unsupported.observe(() => ({
      enabledFeatureFlags: [],
      route: 'explorer',
    }));
    expect(unsupported.getSnapshot()).toMatchObject({
      availability: 'unsupported',
      unavailableReason: 'PerformanceObserver is unavailable in this renderer.',
    });
    disposeUnsupported();
    expect(unsupported.getSnapshot()).toMatchObject({
      availability: 'idle',
      unavailableReason: null,
    });

    class ThrowingPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(_callback: PerformanceObserverCallback) {
        throw new Error('observer construction failed');
      }
    }
    vi.stubGlobal('PerformanceObserver', ThrowingPerformanceObserver);
    const failed = createRendererLongTaskTelemetry();
    const disposeFailed = failed.observe(() => ({
      enabledFeatureFlags: [],
      route: 'explorer',
    }));
    expect(failed.getSnapshot()).toMatchObject({
      availability: 'failed',
      unavailableReason: 'observer construction failed',
    });
    disposeFailed();
    expect(failed.getSnapshot()).toMatchObject({
      availability: 'idle',
      unavailableReason: null,
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
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'unsupported',
      unavailableReason: 'This renderer does not support PerformanceObserver longtask entries.',
    });
  });

  it('treats a missing supported entry type list as explicitly unsupported', () => {
    const observe = vi.fn();
    class UnsupportedPerformanceObserver {
      static readonly supportedEntryTypes = undefined;

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
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'unsupported',
      unavailableReason: 'This renderer does not support PerformanceObserver longtask entries.',
    });
  });

  it('retains buffered entries from occurrence time and deduplicates observer replay', () => {
    const callbacks: PerformanceObserverCallback[] = [];
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(callback: PerformanceObserverCallback) {
        callbacks.push(callback);
      }

      observe(): void {}

      disconnect(): void {}
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    vi.advanceTimersByTime(10_000);
    const telemetry = createRendererLongTaskTelemetry({ windowMs: 1000 });
    telemetry.observe(() => ({
      enabledFeatureFlags: ['diagnostics-v2'],
      route: 'settings',
    }));
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }
    const currentEntry = {
      duration: 75,
      entryType: 'longtask',
      startTime: 9500,
    } as PerformanceEntry;
    const expiredEntry = {
      duration: 80,
      entryType: 'longtask',
      startTime: 8000,
    } as PerformanceEntry;
    const entryList = {
      getEntries: () => [expiredEntry, currentEntry],
    } as PerformanceObserverEntryList;

    callback(entryList, {} as PerformanceObserver);
    callback(entryList, {} as PerformanceObserver);

    expect(telemetry.getSnapshot()).toMatchObject({
      featureFlags: [{ count: 1, flag: 'diagnostics-v2' }],
      routes: [{ count: 1, route: 'settings' }],
      sampleCount: 1,
    });

    vi.advanceTimersByTime(501);
    expect(telemetry.getSnapshot()).toMatchObject({
      featureFlags: [],
      routes: [],
      sampleCount: 0,
    });
  });

  it('keeps observer occurrence and retention timestamps monotonic across wall-clock changes', () => {
    const callbacks: PerformanceObserverCallback[] = [];
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(callback: PerformanceObserverCallback) {
        callbacks.push(callback);
      }

      observe(): void {}

      disconnect(): void {}
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    vi.setSystemTime(performance.timeOrigin + 86_400_000);
    const telemetry = createRendererLongTaskTelemetry({ windowMs: 1000 });
    telemetry.observe(() => ({
      enabledFeatureFlags: ['diagnostics-v2'],
      route: 'settings',
    }));
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }

    callback(
      {
        getEntries: () => [
          {
            duration: 75,
            entryType: 'longtask',
            startTime: performance.now(),
          } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(telemetry.getSnapshot().sampleCount).toBe(1);

    vi.advanceTimersByTime(1001);

    expect(telemetry.getSnapshot()).toMatchObject({
      durationP50Ms: null,
      durationP95Ms: null,
      featureFlags: [],
      maxDurationMs: null,
      routes: [],
      sampleCount: 0,
    });
  });
});
