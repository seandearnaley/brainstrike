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

  it('defers the Performance clock read until collection and surfaces a missing clock', async () => {
    vi.resetModules();
    vi.stubGlobal('performance', undefined);
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      observe(): void {}

      disconnect(): void {}
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);

    const telemetryModule = await import('../diagnostics/renderer-long-task-telemetry');
    const telemetry = telemetryModule.createRendererLongTaskTelemetry();

    expect(() => telemetry.getSnapshot()).not.toThrow();
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      sampleCount: 0,
      snapshotAt: 0,
      unavailableReason: 'Renderer long-task telemetry requires the Performance timing API.',
    });

    telemetry.observe(() => ({ enabledFeatureFlags: [], route: 'explorer' }));

    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      sampleCount: 0,
      snapshotAt: 0,
      unavailableReason: 'Renderer long-task telemetry requires the Performance timing API.',
    });
  });

  it('keeps context publication on the failed snapshot path when the clock is unavailable', () => {
    const clockError = new Error('performance timing is unavailable');
    const telemetry = createRendererLongTaskTelemetry({
      now: () => {
        throw clockError;
      },
    });

    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      unavailableReason: clockError.message,
    });
    const listener = vi.fn();
    telemetry.subscribe(listener);

    expect(() =>
      telemetry.updateContext({
        enabledFeatureFlags: ['diagnostics-v2'],
        route: 'explorer',
      })
    ).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      unavailableReason: clockError.message,
    });
  });

  it('rejects a non-finite injected clock through the failed snapshot path', () => {
    const telemetry = createRendererLongTaskTelemetry({ now: () => Number.NaN });

    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      sampleCount: 0,
      snapshotAt: 0,
      unavailableReason: 'Renderer long-task telemetry clock must return a finite timestamp.',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('routes direct record and reset clock failures into a coherent failed snapshot', () => {
    const telemetry = createRendererLongTaskTelemetry({
      now: () => {
        throw new Error('clock failed');
      },
    });
    const listener = vi.fn();
    telemetry.subscribe(listener);

    expect(() =>
      telemetry.record({
        durationMs: 75,
        enabledFeatureFlags: [],
        route: 'settings',
      })
    ).not.toThrow();
    expect(() => telemetry.reset()).not.toThrow();
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      sampleCount: 0,
      unavailableReason: 'clock failed',
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('rejects a non-finite duration passed to record (%s)', (durationMs) => {
    const telemetry = createRendererLongTaskTelemetry();

    expect(() =>
      telemetry.record({
        durationMs,
        enabledFeatureFlags: [],
        route: 'settings',
      })
    ).toThrow('Renderer long-task telemetry duration must be finite.');
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'idle',
      sampleCount: 0,
    });
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
    vi.advanceTimersByTime(200);
    const entryStartTime = performance.now() - 100;
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

  it('retains an entire buffered batch with one listener publication', () => {
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
    vi.stubGlobal('performance', {
      now: vi.fn(() => 2000),
      timeOrigin: 498_000,
    });
    const telemetry = createRendererLongTaskTelemetry({ now: () => 500_000, windowMs: 1000 });
    const listener = vi.fn();
    telemetry.subscribe(listener);
    telemetry.observe(() => ({ enabledFeatureFlags: [], route: 'explorer' }));
    listener.mockClear();
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }

    callback(
      {
        getEntries: () => [
          { duration: 75, entryType: 'longtask', startTime: 1800 } as PerformanceEntry,
          { duration: 80, entryType: 'longtask', startTime: 1850 } as PerformanceEntry,
          { duration: 90, entryType: 'longtask', startTime: 1900 } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot().sampleCount).toBe(3);
  });

  it('keeps valid buffered entries when a malformed entry fails the delivery', () => {
    const callbacks: PerformanceObserverCallback[] = [];
    const disconnect = vi.fn();
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(callback: PerformanceObserverCallback) {
        callbacks.push(callback);
      }

      observe(): void {}

      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    vi.stubGlobal('performance', {
      now: vi.fn(() => 2000),
      timeOrigin: 498_000,
    });
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(499_999)
      .mockReturnValueOnce(500_000)
      .mockReturnValue(500_001);
    const telemetry = createRendererLongTaskTelemetry({ now, windowMs: 1000 });
    const listener = vi.fn();
    telemetry.subscribe(listener);
    telemetry.observe(() => ({ enabledFeatureFlags: ['diagnostics-v2'], route: 'settings' }));
    listener.mockClear();
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }

    callback(
      {
        getEntries: () => [
          { duration: 75, entryType: 'longtask', startTime: 1900 } as PerformanceEntry,
          { duration: 80, entryType: 'longtask', startTime: Number.NaN } as PerformanceEntry,
          { duration: 80, entryType: 'longtask', startTime: -1 } as PerformanceEntry,
          { duration: 75, entryType: 'longtask', startTime: 1950 } as PerformanceEntry,
          { duration: 90, entryType: 'longtask', startTime: 1850 } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      featureFlags: [{ count: 2, flag: 'diagnostics-v2' }],
      routes: [{ count: 2, route: 'settings' }],
      sampleCount: 2,
      snapshotAt: 500_000,
      unavailableReason:
        'PerformanceObserver longtask batch contains multiple invalid entries: PerformanceObserver longtask entry start time is unavailable. PerformanceObserver longtask entry start time cannot be negative. PerformanceObserver longtask entry completed after delivery.',
    });
    expect(now).toHaveBeenCalledTimes(2);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('fails observation for a non-finite longtask duration (%s)', (duration) => {
    const callbacks: PerformanceObserverCallback[] = [];
    const disconnect = vi.fn();
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(callback: PerformanceObserverCallback) {
        callbacks.push(callback);
      }

      observe(): void {}

      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    vi.stubGlobal('performance', {
      now: vi.fn(() => 2000),
      timeOrigin: 498_000,
    });
    const telemetry = createRendererLongTaskTelemetry({ now: () => 500_000 });
    telemetry.observe(() => ({ enabledFeatureFlags: [], route: 'explorer' }));
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }

    callback(
      {
        getEntries: () => [
          { duration, entryType: 'longtask', startTime: 1900 } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      sampleCount: 0,
      unavailableReason: 'PerformanceObserver longtask entry duration is unavailable.',
    });
  });

  it('arms expiry for valid siblings when a later batch insert fails', () => {
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
    vi.stubGlobal('performance', {
      now: vi.fn(() => 2000),
      timeOrigin: 498_000,
    });
    let contextReadCount = 0;
    let now = 500_000;
    const telemetry = createRendererLongTaskTelemetry({ now: () => now, windowMs: 100 });
    telemetry.observe(() => {
      contextReadCount += 1;
      if (contextReadCount <= 2) {
        return { enabledFeatureFlags: [], route: 'explorer' };
      }
      return {
        enabledFeatureFlags: ['valid', Symbol('invalid') as unknown as string] as readonly string[],
        route: 'settings',
      };
    });
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }

    callback(
      {
        getEntries: () => [
          { duration: 75, entryType: 'longtask', startTime: 1900 } as PerformanceEntry,
          { duration: 80, entryType: 'longtask', startTime: 1900 } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(telemetry.getSnapshot()).toMatchObject({ availability: 'failed', sampleCount: 1 });
    expect(vi.getTimerCount()).toBe(1);
    now += 1;
    vi.advanceTimersByTime(101);
    expect(telemetry.getSnapshot().sampleCount).toBe(0);
  });

  it('fails observation when the Performance API disappears after an injected clock read', () => {
    const callbacks: PerformanceObserverCallback[] = [];
    const disconnect = vi.fn();
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(callback: PerformanceObserverCallback) {
        callbacks.push(callback);
      }

      observe(): void {}

      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    const telemetry = createRendererLongTaskTelemetry({ now: () => 500_000 });
    telemetry.observe(() => ({ enabledFeatureFlags: [], route: 'explorer' }));
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }
    vi.stubGlobal('performance', undefined);

    callback(
      { getEntries: () => [] } as unknown as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      unavailableReason: 'Renderer long-task telemetry requires the Performance timing API.',
    });
  });

  it('fails observation when the Performance elapsed clock becomes non-finite', () => {
    const callbacks: PerformanceObserverCallback[] = [];
    const disconnect = vi.fn();
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(callback: PerformanceObserverCallback) {
        callbacks.push(callback);
      }

      observe(): void {}

      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    vi.stubGlobal('performance', { now: vi.fn(() => Number.NaN), timeOrigin: 498_000 });
    const telemetry = createRendererLongTaskTelemetry({ now: () => 500_000 });
    telemetry.observe(() => ({ enabledFeatureFlags: [], route: 'explorer' }));
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }

    callback(
      { getEntries: () => [] } as unknown as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      unavailableReason: 'PerformanceObserver longtask entry timing is unavailable.',
    });
  });

  it('rejects a buffered entry whose occurrence maps after its delivery', () => {
    const callbacks: PerformanceObserverCallback[] = [];
    const disconnect = vi.fn();
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(callback: PerformanceObserverCallback) {
        callbacks.push(callback);
      }

      observe(): void {}

      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    vi.stubGlobal('performance', {
      now: vi.fn(() => 2000),
      timeOrigin: 498_000,
    });
    const telemetry = createRendererLongTaskTelemetry({
      now: () => 500_000,
      windowMs: 1000,
    });
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
          { duration: 75, entryType: 'longtask', startTime: 2001 } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      featureFlags: [],
      routes: [],
      sampleCount: 0,
      unavailableReason: 'PerformanceObserver longtask entry completed after delivery.',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a buffered entry whose completion maps after its delivery', () => {
    const callbacks: PerformanceObserverCallback[] = [];
    const disconnect = vi.fn();
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(callback: PerformanceObserverCallback) {
        callbacks.push(callback);
      }

      observe(): void {}

      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    vi.stubGlobal('performance', {
      now: vi.fn(() => 2000),
      timeOrigin: 498_000,
    });
    const telemetry = createRendererLongTaskTelemetry({
      now: () => 500_000,
      windowMs: 1000,
    });
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
          { duration: 75, entryType: 'longtask', startTime: 1950 } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      featureFlags: [],
      routes: [],
      sampleCount: 0,
      unavailableReason: 'PerformanceObserver longtask entry completed after delivery.',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts sub-millisecond completion rounding without disconnecting observation', () => {
    const callbacks: PerformanceObserverCallback[] = [];
    const disconnect = vi.fn();
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(callback: PerformanceObserverCallback) {
        callbacks.push(callback);
      }

      observe(): void {}

      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    vi.stubGlobal('performance', {
      now: vi.fn(() => 2000),
      timeOrigin: 498_000,
    });
    const telemetry = createRendererLongTaskTelemetry({
      now: () => 500_000,
      windowMs: 1000,
    });
    telemetry.observe(() => ({ enabledFeatureFlags: [], route: 'explorer' }));
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }

    callback(
      {
        getEntries: () => [
          { duration: 50.5, entryType: 'longtask', startTime: 1950 } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(disconnect).not.toHaveBeenCalled();
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'active',
      sampleCount: 1,
      unavailableReason: null,
    });
  });

  it('maps observer entry age into the injected retention-clock domain', () => {
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
    vi.stubGlobal('performance', {
      now: vi.fn(() => 2000),
      timeOrigin: 1000,
    });
    const telemetry = createRendererLongTaskTelemetry({
      now: () => 500_000,
      windowMs: 1000,
    });
    telemetry.observe(() => ({ enabledFeatureFlags: [], route: 'explorer' }));
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
            startTime: 1900,
          } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(telemetry.getSnapshot()).toMatchObject({
      routes: [{ count: 1, route: 'explorer' }],
      sampleCount: 1,
    });
  });

  it('deduplicates buffered replay after an in-window sample is evicted by the cap', () => {
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
    vi.stubGlobal('performance', {
      now: vi.fn(() => 2000),
      timeOrigin: 498_000,
    });
    const telemetry = createRendererLongTaskTelemetry({
      maxSamples: 1,
      now: () => 500_000,
      windowMs: 1000,
    });
    const listener = vi.fn();
    telemetry.subscribe(listener);
    telemetry.observe(() => ({ enabledFeatureFlags: [], route: 'explorer' }));
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }
    const entryList = {
      getEntries: () => [
        { duration: 75, entryType: 'longtask', startTime: 1900 } as PerformanceEntry,
        { duration: 80, entryType: 'longtask', startTime: 1920 } as PerformanceEntry,
      ],
    } as PerformanceObserverEntryList;

    callback(entryList, {} as PerformanceObserver);
    listener.mockClear();
    callback(entryList, {} as PerformanceObserver);

    expect(listener).not.toHaveBeenCalled();
    expect(telemetry.getSnapshot().sampleCount).toBe(1);
  });

  it('deduplicates a buffered entry when delivery timing changes across observers', () => {
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
    vi.stubGlobal('performance', {
      now: vi.fn().mockReturnValueOnce(2000).mockReturnValueOnce(2003),
      timeOrigin: 498_000,
    });
    let now = 500_000;
    const telemetry = createRendererLongTaskTelemetry({
      now: () => now,
      windowMs: 1000,
    });
    const entryList = {
      getEntries: () => [
        { duration: 75, entryType: 'longtask', startTime: 1900 } as PerformanceEntry,
      ],
    } as PerformanceObserverEntryList;
    const getContext = (): RendererLongTaskContext => ({
      enabledFeatureFlags: [],
      route: 'explorer',
    });

    const disposeFirstObserver = telemetry.observe(getContext);
    const firstCallback = callbacks.at(0);
    if (!firstCallback) {
      throw new Error('Expected the first PerformanceObserver callback to be registered.');
    }
    firstCallback(entryList, {} as PerformanceObserver);
    disposeFirstObserver();

    now += 10;
    telemetry.observe(getContext);
    const secondCallback = callbacks.at(1);
    if (!secondCallback) {
      throw new Error('Expected the replacement PerformanceObserver callback to be registered.');
    }
    const listener = vi.fn();
    telemetry.subscribe(listener);
    secondCallback(entryList, {} as PerformanceObserver);

    expect(listener).not.toHaveBeenCalled();
    expect(telemetry.getSnapshot().sampleCount).toBe(1);
  });

  it('evicts dedupe keys by occurrence time instead of delivery order', () => {
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
    vi.stubGlobal('performance', {
      now: vi.fn(() => 2100),
      timeOrigin: 498_000,
    });
    const telemetry = createRendererLongTaskTelemetry({
      maxSamples: 1,
      now: () => 500_000,
      windowMs: 150,
    });
    const listener = vi.fn();
    telemetry.subscribe(listener);
    telemetry.observe(() => ({ enabledFeatureFlags: [], route: 'explorer' }));
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }
    callback(
      {
        getEntries: () => [
          { duration: 75, entryType: 'longtask', startTime: 1990 } as PerformanceEntry,
          { duration: 80, entryType: 'longtask', startTime: 1960 } as PerformanceEntry,
          { duration: 90, entryType: 'longtask', startTime: 1980 } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );
    listener.mockClear();

    callback(
      {
        getEntries: () => [
          { duration: 75, entryType: 'longtask', startTime: 1990 } as PerformanceEntry,
        ],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(listener).not.toHaveBeenCalled();
    expect(telemetry.getSnapshot().sampleCount).toBe(1);
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
      featureFlagContextSampleCount: 0,
      sampleCount: 1,
    });

    telemetry.record({
      durationMs: 80,
      enabledFeatureFlags: ['diagnostics-v2'],
      route: 'explorer',
    });
    expect(telemetry.getSnapshot()).toMatchObject({
      featureFlagContextAvailability: 'mixed',
      featureFlagContextSampleCount: 1,
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

    expect(now).not.toHaveBeenCalled();

    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: [],
      route: 'settings',
    });

    expect(now).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).toMatchObject({ sampleCount: 1 });
    expect(now).toHaveBeenCalledTimes(2);
    expect(telemetry.getSnapshot()).toBe(telemetry.getSnapshot());
    expect(now).toHaveBeenCalledTimes(2);
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

  it('clears retained context without retrying when the retention clock fails', () => {
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(1000)
      .mockImplementationOnce(() => {
        throw new Error('retention clock failed');
      });
    const telemetry = createRendererLongTaskTelemetry({ now, windowMs: 100 });
    telemetry.subscribe(vi.fn());
    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: ['private-preview'],
      route: 'settings',
    });

    vi.advanceTimersByTime(101);

    expect(now).toHaveBeenCalledTimes(2);
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      featureFlags: [],
      routes: [],
      sampleCount: 0,
      unavailableReason: 'retention clock failed',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defers destructive clock-failure cleanup from getSnapshot to a non-render entry point', () => {
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(1000)
      .mockImplementationOnce(() => {
        throw new Error('snapshot clock failed');
      })
      .mockReturnValue(1050);
    const telemetry = createRendererLongTaskTelemetry({ now, windowMs: 100 });
    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: ['private-preview'],
      route: 'settings',
    });
    const listener = vi.fn();
    telemetry.subscribe(listener);

    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      featureFlags: [],
      routes: [],
      sampleCount: 0,
      snapshotAt: 1000,
      unavailableReason: 'snapshot clock failed',
    });
    expect(now).toHaveBeenCalledTimes(2);
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    telemetry.updateContext({ enabledFeatureFlags: [], route: 'explorer' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      featureFlags: [],
      routes: [],
      sampleCount: 0,
      unavailableReason: 'snapshot clock failed',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases deferred context before rejecting a record in failed state', () => {
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(1000)
      .mockImplementationOnce(() => {
        throw new Error('snapshot clock failed');
      });
    const telemetry = createRendererLongTaskTelemetry({ now, windowMs: 100 });
    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: ['private-preview'],
      route: 'settings',
    });

    expect(telemetry.getSnapshot()).toMatchObject({ availability: 'failed', sampleCount: 0 });
    expect(vi.getTimerCount()).toBe(1);

    expect(() =>
      telemetry.record({
        durationMs: 90,
        enabledFeatureFlags: [],
        route: 'explorer',
      })
    ).toThrow('Cannot record renderer long-task telemetry while observation is failed.');
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

  it('rejects direct samples after observer failure', () => {
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

    expect(() =>
      telemetry.record({
        durationMs: 75,
        enabledFeatureFlags: [],
        route: 'settings',
      })
    ).toThrow('Cannot record renderer long-task telemetry while observation is failed.');

    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      sampleCount: 0,
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
    expect(() =>
      unsupported.record({
        durationMs: 75,
        enabledFeatureFlags: ['private-preview'],
        route: 'settings',
      })
    ).toThrow('Cannot record renderer long-task telemetry while observation is unsupported.');
    expect(vi.getTimerCount()).toBe(0);
    disposeUnsupported();
    expect(unsupported.getSnapshot()).toMatchObject({
      availability: 'idle',
      featureFlags: [],
      routes: [],
      sampleCount: 0,
      unavailableReason: null,
    });
    expect(vi.getTimerCount()).toBe(0);

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

  it('reports an epoch-zero unsupported snapshot before the first clock read', () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    const now = vi.fn(() => {
      throw new Error('clock failed');
    });
    const telemetry = createRendererLongTaskTelemetry({
      now,
    });

    let dispose: (() => void) | undefined;
    expect(() => {
      dispose = telemetry.observe(() => ({ enabledFeatureFlags: [], route: 'explorer' }));
    }).not.toThrow();
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'unsupported',
      snapshotAt: 0,
      unavailableReason: 'PerformanceObserver is unavailable in this renderer.',
    });
    expect(now).not.toHaveBeenCalled();

    dispose?.();

    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'idle',
      sampleCount: 0,
      unavailableReason: null,
    });
  });

  it('publishes and retains an explicitly empty window when observation is unsupported', () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    let now = 500_000;
    const telemetry = createRendererLongTaskTelemetry({ now: () => now, windowMs: 1000 });
    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: ['private-preview'],
      route: 'settings',
    });
    expect(vi.getTimerCount()).toBe(1);
    const listener = vi.fn();
    telemetry.subscribe(listener);

    telemetry.observe(() => ({ enabledFeatureFlags: [], route: 'explorer' }));

    const unsupportedSnapshot = telemetry.getSnapshot();
    expect(unsupportedSnapshot).toMatchObject({
      availability: 'unsupported',
      featureFlags: [],
      routes: [],
      sampleCount: 0,
      snapshotAt: 500_000,
      unavailableReason: 'PerformanceObserver is unavailable in this renderer.',
    });
    expect(vi.getTimerCount()).toBe(0);

    listener.mockClear();
    now += 1001;
    vi.advanceTimersByTime(1001);

    expect(listener).not.toHaveBeenCalled();
    expect(telemetry.getSnapshot()).toBe(unsupportedSnapshot);
  });

  it('preserves the observer failure reason when publishing also loses the clock', () => {
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      observe(): void {}

      disconnect(): void {}
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    vi.stubGlobal('performance', {
      now: vi.fn(() => 2000),
      timeOrigin: 498_000,
    });
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(500_000)
      .mockImplementation(() => {
        throw new Error('clock failed');
      });
    const telemetry = createRendererLongTaskTelemetry({ now, windowMs: 1000 });
    const dispose = telemetry.observe(() => {
      throw new Error('context collection failed');
    });

    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      sampleCount: 0,
      unavailableReason: 'context collection failed (clock unavailable: clock failed)',
    });
    dispose();

    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      sampleCount: 0,
      unavailableReason: 'context collection failed (clock unavailable: clock failed)',
    });
  });

  it('disconnects the observer when the delivery clock fails', () => {
    const callbacks: PerformanceObserverCallback[] = [];
    const disconnect = vi.fn();
    class MockPerformanceObserver {
      static readonly supportedEntryTypes = ['longtask'];

      constructor(callback: PerformanceObserverCallback) {
        callbacks.push(callback);
      }

      observe(): void {}

      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(500_000)
      .mockImplementation(() => {
        throw new Error('delivery clock failed');
      });
    const telemetry = createRendererLongTaskTelemetry({ now });
    telemetry.observe(() => ({ enabledFeatureFlags: [], route: 'explorer' }));
    const callback = callbacks.at(0);
    if (!callback) {
      throw new Error('Expected PerformanceObserver callback to be registered.');
    }

    callback(
      { getEntries: () => [] } as unknown as PerformanceObserverEntryList,
      {} as PerformanceObserver
    );

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'failed',
      sampleCount: 0,
      unavailableReason: 'delivery clock failed',
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
    const telemetry = createRendererLongTaskTelemetry({ now: () => 1000, windowMs: 100 });
    telemetry.record({
      durationMs: 75,
      enabledFeatureFlags: ['private-preview'],
      route: 'settings',
    });
    expect(vi.getTimerCount()).toBe(1);

    telemetry.observe(() => ({
      enabledFeatureFlags: [],
      route: 'explorer',
    }));

    expect(observe).not.toHaveBeenCalled();
    expect(telemetry.getSnapshot()).toMatchObject({
      availability: 'unsupported',
      featureFlags: [],
      routes: [],
      sampleCount: 0,
      snapshotAt: 1000,
      unavailableReason: 'This renderer does not support PerformanceObserver longtask entries.',
    });
    expect(vi.getTimerCount()).toBe(0);
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
    vi.advanceTimersByTime(200);
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
            startTime: performance.now() - 100,
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
