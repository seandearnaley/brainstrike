const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_SAMPLES = 512;
const LONG_TASK_MIN_DURATION_MS = 50;

function isLongTaskDuration(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs >= LONG_TASK_MIN_DURATION_MS;
}

function readMonotonicEpochTime(): number {
  if (typeof performance === 'undefined') {
    throw new Error('Renderer long-task telemetry requires the Performance timing API.');
  }
  const timeOrigin = performance.timeOrigin;
  const elapsedMs = performance.now();
  if (!(Number.isFinite(timeOrigin) && Number.isFinite(elapsedMs))) {
    throw new Error('Renderer long-task telemetry performance timing is unavailable.');
  }
  // PerformanceEntry.startTime uses this monotonic timeline. Date.now() must
  // not drive retention because wall-clock adjustments would split the clocks.
  return timeOrigin + elapsedMs;
}

export type RendererDiagnosticSurface = 'explorer' | 'git' | 'notes' | 'settings' | 'terminal';

export interface RendererLongTaskContext {
  /** Null means the app has no authoritative feature-flag source to provide. */
  readonly enabledFeatureFlags: readonly string[] | null;
  readonly route: RendererDiagnosticSurface;
}

export interface RendererLongTaskMetric extends RendererLongTaskContext {
  readonly durationMs: number;
}

interface RendererLongTaskSample extends RendererLongTaskMetric {
  readonly observedAt: number;
  readonly performanceEntryKey?: string;
}

export interface RendererLongTaskRouteSummary {
  readonly count: number;
  readonly route: RendererDiagnosticSurface;
}

export interface RendererLongTaskFeatureFlagSummary {
  readonly count: number;
  readonly flag: string;
}

export interface RendererLongTaskTelemetrySnapshot {
  readonly availability: 'active' | 'failed' | 'idle' | 'unsupported';
  readonly durationP50Ms: number | null;
  readonly durationP95Ms: number | null;
  readonly featureFlagContextAvailability: 'available' | 'mixed' | 'unavailable';
  readonly featureFlags: readonly RendererLongTaskFeatureFlagSummary[];
  readonly maxDurationMs: number | null;
  readonly routes: readonly RendererLongTaskRouteSummary[];
  readonly sampleCount: number;
  readonly snapshotAt: number;
  readonly unavailableReason: string | null;
  readonly windowMs: number;
}

interface RendererLongTaskTelemetryOptions {
  readonly maxSamples?: number;
  readonly now?: () => number;
  readonly windowMs?: number;
}

export interface RendererLongTaskTelemetry {
  readonly getSnapshot: () => RendererLongTaskTelemetrySnapshot;
  readonly observe: (getContext: () => RendererLongTaskContext) => () => void;
  readonly record: (metric: RendererLongTaskMetric) => void;
  /** Disconnects collection, clears retained samples, and restores the idle state. */
  readonly reset: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly updateContext: (context: RendererLongTaskContext) => void;
}

function readPercentile(sortedValues: readonly number[], percentile: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(percentile * sortedValues.length) - 1)
  );
  return sortedValues[index] ?? null;
}

function normalizeFeatureFlags(flags: readonly string[] | null): readonly string[] | null {
  if (flags === null) {
    return null;
  }
  return [...new Set(flags)].sort((left, right) => left.localeCompare(right));
}

export function createRendererLongTaskTelemetry(
  options: RendererLongTaskTelemetryOptions = {}
): RendererLongTaskTelemetry {
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const now = options.now ?? readMonotonicEpochTime;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  if (!(Number.isInteger(maxSamples) && maxSamples > 0)) {
    throw new Error('Renderer long-task telemetry maxSamples must be a positive integer.');
  }
  if (!(Number.isFinite(windowMs) && windowMs > 0)) {
    throw new Error('Renderer long-task telemetry windowMs must be positive.');
  }

  let availability: RendererLongTaskTelemetrySnapshot['availability'] = 'idle';
  let activeObserver: PerformanceObserver | null = null;
  let currentFeatureFlagContextAvailability: Exclude<
    RendererLongTaskTelemetrySnapshot['featureFlagContextAvailability'],
    'mixed'
  > = 'unavailable';
  const listeners = new Set<() => void>();
  let observationGeneration = 0;
  const performanceEntryKeys = new Set<string>();
  let retentionTimer: ReturnType<typeof setTimeout> | null = null;
  let samples: RendererLongTaskSample[] = [];
  let unavailableReason: string | null = null;

  const prune = (snapshotAt: number): boolean => {
    const threshold = snapshotAt - windowMs;
    const sampleCountBeforePrune = samples.length;
    samples = samples.filter((sample) => {
      if (sample.observedAt >= threshold) {
        return true;
      }
      if (sample.performanceEntryKey !== undefined) {
        performanceEntryKeys.delete(sample.performanceEntryKey);
      }
      return false;
    });
    return samples.length !== sampleCountBeforePrune;
  };

  const buildSnapshot = (snapshotAt: number): RendererLongTaskTelemetrySnapshot => {
    const threshold = snapshotAt - windowMs;
    const currentSamples = samples.filter((sample) => sample.observedAt >= threshold);
    const durations = currentSamples
      .map((sample) => sample.durationMs)
      .sort((left, right) => left - right);
    const countsByRoute = new Map<RendererDiagnosticSurface, number>();
    const countsByFeatureFlag = new Map<string, number>();
    let hasAvailableFeatureFlagContext = false;
    let hasUnavailableFeatureFlagContext = false;
    for (const sample of currentSamples) {
      countsByRoute.set(sample.route, (countsByRoute.get(sample.route) ?? 0) + 1);
      if (sample.enabledFeatureFlags === null) {
        hasUnavailableFeatureFlagContext = true;
      } else {
        hasAvailableFeatureFlagContext = true;
      }
      for (const flag of sample.enabledFeatureFlags ?? []) {
        countsByFeatureFlag.set(flag, (countsByFeatureFlag.get(flag) ?? 0) + 1);
      }
    }
    const featureFlags = [...countsByFeatureFlag.entries()]
      .map(([flag, count]) => ({ count, flag }))
      .sort((left, right) => left.flag.localeCompare(right.flag));
    const routes = [...countsByRoute.entries()]
      .map(([route, count]) => ({ count, route }))
      .sort((left, right) => left.route.localeCompare(right.route));
    return {
      availability,
      durationP50Ms: readPercentile(durations, 0.5),
      durationP95Ms: readPercentile(durations, 0.95),
      featureFlagContextAvailability:
        currentSamples.length === 0
          ? currentFeatureFlagContextAvailability
          : hasAvailableFeatureFlagContext && hasUnavailableFeatureFlagContext
            ? 'mixed'
            : hasAvailableFeatureFlagContext
              ? 'available'
              : 'unavailable',
      featureFlags,
      maxDurationMs: durations.at(-1) ?? null,
      routes,
      sampleCount: currentSamples.length,
      snapshotAt,
      unavailableReason,
      windowMs,
    };
  };

  let currentSnapshot = buildSnapshot(now());
  let snapshotDirty = false;

  const releaseCachedSampleContext = (snapshotAt: number): void => {
    currentSnapshot = {
      ...currentSnapshot,
      durationP50Ms: null,
      durationP95Ms: null,
      featureFlags: [],
      maxDurationMs: null,
      routes: [],
      sampleCount: 0,
      snapshotAt,
    };
    snapshotDirty = true;
  };

  const publishSnapshot = (snapshotAt: number): void => {
    currentSnapshot = buildSnapshot(snapshotAt);
    snapshotDirty = false;
    for (const listener of listeners) {
      listener();
    }
  };

  const publish = (): void => {
    snapshotDirty = true;
    if (listeners.size === 0) {
      return;
    }
    publishSnapshot(now());
  };

  const scheduleRetentionPrune = (scheduledAt: number): void => {
    if (retentionTimer !== null) {
      clearTimeout(retentionTimer);
      retentionTimer = null;
    }
    const oldestSample = samples[0];
    if (!oldestSample) {
      return;
    }
    const delayMs = Math.max(1, oldestSample.observedAt + windowMs - scheduledAt + 1);
    retentionTimer = setTimeout(() => {
      retentionTimer = null;
      const snapshotAt = now();
      const pruned = prune(snapshotAt);
      scheduleRetentionPrune(snapshotAt);
      if (!pruned) {
        return;
      }
      releaseCachedSampleContext(snapshotAt);
      if (listeners.size > 0) {
        publishSnapshot(snapshotAt);
      }
    }, delayMs);
  };

  const insertSample = (sample: RendererLongTaskSample): void => {
    const latestSample = samples.at(-1);
    if (!latestSample || latestSample.observedAt <= sample.observedAt) {
      samples.push(sample);
      return;
    }
    const insertionIndex = samples.findIndex(
      (retainedSample) => retainedSample.observedAt > sample.observedAt
    );
    if (insertionIndex < 0) {
      throw new Error('Renderer long-task telemetry sample ordering invariant failed.');
    }
    samples.splice(insertionIndex, 0, sample);
  };

  const evictSamplesOverCap = (): boolean => {
    const overflowCount = samples.length - maxSamples;
    if (overflowCount <= 0) {
      return false;
    }
    const evictedSamples = samples.splice(0, overflowCount);
    for (const evictedSample of evictedSamples) {
      if (evictedSample.performanceEntryKey !== undefined) {
        performanceEntryKeys.delete(evictedSample.performanceEntryKey);
      }
    }
    return true;
  };

  const recordAt = (
    metric: RendererLongTaskMetric,
    observedAt: number,
    scheduledAt: number,
    performanceEntryKey?: string
  ): void => {
    if (!Number.isFinite(observedAt)) {
      throw new Error('Renderer long-task telemetry observedAt must be finite.');
    }
    if (performanceEntryKey !== undefined && performanceEntryKeys.has(performanceEntryKey)) {
      return;
    }

    const sample: RendererLongTaskSample = {
      ...metric,
      enabledFeatureFlags: normalizeFeatureFlags(metric.enabledFeatureFlags),
      observedAt,
      ...(performanceEntryKey === undefined ? {} : { performanceEntryKey }),
    };
    insertSample(sample);
    if (performanceEntryKey !== undefined) {
      performanceEntryKeys.add(performanceEntryKey);
    }

    const pruned = prune(scheduledAt);
    const sampleCapEvicted = evictSamplesOverCap();
    if (pruned || sampleCapEvicted) {
      // Releasing cached identifiers is O(1); the next read rebuilds the full
      // snapshot lazily, while an observed store rebuilds once in publish().
      releaseCachedSampleContext(scheduledAt);
    }
    scheduleRetentionPrune(scheduledAt);
    publish();
  };

  const record = (metric: RendererLongTaskMetric): void => {
    if (!isLongTaskDuration(metric.durationMs)) {
      return;
    }
    const observedAt = now();
    recordAt(metric, observedAt, observedAt);
  };

  const getSnapshot = (): RendererLongTaskTelemetrySnapshot => {
    if (snapshotDirty) {
      currentSnapshot = buildSnapshot(now());
      snapshotDirty = false;
    }
    return currentSnapshot;
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const updateContext = (context: RendererLongTaskContext): void => {
    const nextAvailability = context.enabledFeatureFlags === null ? 'unavailable' : 'available';
    if (currentFeatureFlagContextAvailability === nextAvailability) {
      return;
    }
    currentFeatureFlagContextAvailability = nextAvailability;
    publish();
  };

  const recordPerformanceEntries = (
    list: PerformanceObserverEntryList,
    getContext: () => RendererLongTaskContext
  ): void => {
    for (const entry of list.getEntries()) {
      if (entry.entryType !== 'longtask' || !isLongTaskDuration(entry.duration)) {
        continue;
      }
      const deliveredAt = now();
      const timeOrigin = performance.timeOrigin;
      if (!(Number.isFinite(timeOrigin) && Number.isFinite(entry.startTime))) {
        throw new Error('PerformanceObserver longtask entry timing is unavailable.');
      }
      const observedAt = timeOrigin + entry.startTime;
      if (observedAt < deliveredAt - windowMs) {
        continue;
      }
      recordAt(
        { ...getContext(), durationMs: entry.duration },
        observedAt,
        deliveredAt,
        `${observedAt}:${entry.duration}`
      );
    }
  };

  const observe = (getContext: () => RendererLongTaskContext): (() => void) => {
    if (activeObserver !== null) {
      throw new Error('Renderer long-task telemetry observer is already active.');
    }
    const currentObservationGeneration = observationGeneration + 1;
    observationGeneration = currentObservationGeneration;
    const disposeInactiveObservation =
      (expectedAvailability: 'failed' | 'unsupported'): (() => void) =>
      () => {
        if (
          observationGeneration !== currentObservationGeneration ||
          activeObserver !== null ||
          availability !== expectedAvailability
        ) {
          return;
        }
        availability = 'idle';
        unavailableReason = null;
        publish();
      };
    if (typeof PerformanceObserver === 'undefined') {
      availability = 'unsupported';
      unavailableReason = 'PerformanceObserver is unavailable in this renderer.';
      publish();
      return disposeInactiveObservation('unsupported');
    }
    let observer: PerformanceObserver | null = null;
    try {
      const supportedEntryTypes = PerformanceObserver.supportedEntryTypes;
      if (!(Array.isArray(supportedEntryTypes) && supportedEntryTypes.includes('longtask'))) {
        availability = 'unsupported';
        unavailableReason = 'This renderer does not support PerformanceObserver longtask entries.';
        publish();
        return disposeInactiveObservation('unsupported');
      }

      const initialContext = getContext();
      currentFeatureFlagContextAvailability =
        initialContext.enabledFeatureFlags === null ? 'unavailable' : 'available';

      const createdObserver = new PerformanceObserver((list) => {
        try {
          recordPerformanceEntries(list, getContext);
        } catch (error) {
          createdObserver.disconnect();
          if (activeObserver === createdObserver) {
            activeObserver = null;
          }
          availability = 'failed';
          unavailableReason = error instanceof Error ? error.message : String(error);
          publish();
        }
      });
      observer = createdObserver;
      activeObserver = createdObserver;
      createdObserver.observe({ buffered: true, type: 'longtask' });
      availability = 'active';
      unavailableReason = null;
      publish();
      return () => {
        if (observationGeneration !== currentObservationGeneration) {
          return;
        }
        if (activeObserver === createdObserver) {
          createdObserver.disconnect();
          activeObserver = null;
          availability = 'idle';
          unavailableReason = null;
          publish();
          return;
        }
        if (availability === 'failed') {
          unavailableReason = null;
          availability = 'idle';
          publish();
        }
      };
    } catch (error) {
      observer?.disconnect();
      if (activeObserver === observer) {
        activeObserver = null;
      }
      availability = 'failed';
      unavailableReason = error instanceof Error ? error.message : String(error);
      publish();
      return disposeInactiveObservation('failed');
    }
  };

  const reset = (): void => {
    observationGeneration += 1;
    activeObserver?.disconnect();
    activeObserver = null;
    if (retentionTimer !== null) {
      clearTimeout(retentionTimer);
      retentionTimer = null;
    }
    availability = 'idle';
    currentFeatureFlagContextAvailability = 'unavailable';
    performanceEntryKeys.clear();
    samples = [];
    unavailableReason = null;
    // Reset is a privacy boundary: rebuild even without listeners so the
    // external-store cache releases all previously retained identifiers now.
    publishSnapshot(now());
  };

  return { getSnapshot, observe, record, reset, subscribe, updateContext };
}

export const rendererLongTaskTelemetry = createRendererLongTaskTelemetry();
