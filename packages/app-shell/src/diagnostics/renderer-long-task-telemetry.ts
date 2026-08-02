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

interface PendingRendererLongTaskMetric {
  readonly metric: RendererLongTaskMetric;
  readonly observedAt: number;
  readonly performanceEntryKey: string;
}

type PreparedPerformanceEntry =
  | { readonly kind: 'ignored' }
  | { readonly error: unknown; readonly kind: 'invalid' }
  | { readonly kind: 'metric'; readonly pendingMetric: PendingRendererLongTaskMetric };

interface PreparedPerformanceEntryBatch {
  readonly hasPreparationError: boolean;
  readonly pendingMetrics: readonly PendingRendererLongTaskMetric[];
  readonly preparationError: unknown;
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
  /**
   * Disconnects collection and clears retained samples. A usable clock restores
   * idle; an unusable clock latches the explicit failed state.
   */
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

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const maxPerformanceEntryKeys = Math.max(
    maxSamples,
    Math.ceil(windowMs / LONG_TASK_MIN_DURATION_MS) + 1
  );
  const performanceEntryKeys = new Map<string, number>();
  let retentionTimer: ReturnType<typeof setTimeout> | null = null;
  let samples: RendererLongTaskSample[] = [];
  let unavailableReason: string | null = null;

  const prune = (snapshotAt: number): boolean => {
    if (samples.length === 0) {
      return false;
    }
    const threshold = snapshotAt - windowMs;
    const firstRetainedIndex = samples.findIndex((sample) => sample.observedAt >= threshold);
    if (firstRetainedIndex === 0) {
      return false;
    }
    samples = firstRetainedIndex < 0 ? [] : samples.slice(firstRetainedIndex);
    for (const [key, observedAt] of performanceEntryKeys) {
      if (observedAt < threshold) {
        performanceEntryKeys.delete(key);
      }
    }
    return true;
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

  // Module construction must not turn a missing timing capability into a shell
  // import failure. The first collection/read validates the clock instead.
  let currentSnapshot = buildSnapshot(0);
  let snapshotDirty = true;

  const buildEmptySnapshot = (snapshotAt: number): RendererLongTaskTelemetrySnapshot => ({
    availability,
    durationP50Ms: null,
    durationP95Ms: null,
    featureFlagContextAvailability: currentFeatureFlagContextAvailability,
    featureFlags: [],
    maxDurationMs: null,
    routes: [],
    sampleCount: 0,
    snapshotAt,
    unavailableReason,
    windowMs,
  });

  const releaseCachedSampleContext = (snapshotAt: number): void => {
    currentSnapshot = buildEmptySnapshot(snapshotAt);
    snapshotDirty = true;
  };

  const publishSnapshot = (snapshotAt: number): void => {
    currentSnapshot = buildSnapshot(snapshotAt);
    snapshotDirty = false;
    for (const listener of listeners) {
      listener();
    }
  };

  const publishEmptySnapshot = (snapshotAt: number): void => {
    currentSnapshot = buildEmptySnapshot(snapshotAt);
    snapshotDirty = false;
    for (const listener of listeners) {
      listener();
    }
  };

  const releaseRetainedSampleContext = (): void => {
    if (retentionTimer !== null) {
      clearTimeout(retentionTimer);
      retentionTimer = null;
    }
    samples = [];
    performanceEntryKeys.clear();
  };

  const setFailedSnapshot = (
    error: unknown,
    notifyListeners: boolean,
    releaseRetainedContext = false
  ): void => {
    availability = 'failed';
    const failureReason = readErrorMessage(error);
    unavailableReason = failureReason;
    let snapshotAt = 0;
    let shouldReleaseRetainedContext = releaseRetainedContext;
    try {
      snapshotAt = now();
    } catch (clockError) {
      shouldReleaseRetainedContext = true;
      const clockFailureReason = readErrorMessage(clockError);
      unavailableReason =
        clockFailureReason === failureReason
          ? failureReason
          : `${failureReason} (clock unavailable: ${clockFailureReason})`;
    }
    if (shouldReleaseRetainedContext) {
      releaseRetainedSampleContext();
    }
    currentSnapshot = buildSnapshot(snapshotAt);
    snapshotDirty = false;
    if (notifyListeners) {
      for (const listener of listeners) {
        listener();
      }
    }
  };

  const publishFailedSnapshot = (error: unknown): void => {
    setFailedSnapshot(error, true);
  };

  const readClock = (notifyListeners: boolean): number | null => {
    try {
      return now();
    } catch (error) {
      setFailedSnapshot(error, notifyListeners, true);
      return null;
    }
  };

  const publish = (): void => {
    snapshotDirty = true;
    if (listeners.size === 0) {
      return;
    }
    const snapshotAt = readClock(true);
    if (snapshotAt === null) {
      return;
    }
    publishSnapshot(snapshotAt);
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
      const snapshotAt = readClock(true);
      if (snapshotAt === null) {
        return;
      }
      const pruned = prune(snapshotAt);
      scheduleRetentionPrune(snapshotAt);
      if (!pruned) {
        return;
      }
      if (listeners.size === 0) {
        releaseCachedSampleContext(snapshotAt);
        return;
      }
      publishSnapshot(snapshotAt);
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
      samples.push(sample);
      return;
    }
    samples.splice(insertionIndex, 0, sample);
  };

  const evictSamplesOverCap = (): boolean => {
    const overflowCount = samples.length - maxSamples;
    if (overflowCount <= 0) {
      return false;
    }
    samples.splice(0, overflowCount);
    return true;
  };

  const evictPerformanceEntryKeysOverCap = (): void => {
    const overflowCount = performanceEntryKeys.size - maxPerformanceEntryKeys;
    if (overflowCount <= 0) {
      return;
    }
    const oldestKeys = [...performanceEntryKeys.entries()]
      .sort((left, right) => left[1] - right[1])
      .slice(0, overflowCount);
    for (const [key] of oldestKeys) {
      performanceEntryKeys.delete(key);
    }
  };

  const insertMetric = (
    metric: RendererLongTaskMetric,
    observedAt: number,
    performanceEntryKey?: string
  ): boolean => {
    if (!Number.isFinite(observedAt)) {
      throw new Error('Renderer long-task telemetry observedAt must be finite.');
    }
    if (performanceEntryKey !== undefined && performanceEntryKeys.has(performanceEntryKey)) {
      return false;
    }

    const sample: RendererLongTaskSample = {
      ...metric,
      enabledFeatureFlags: normalizeFeatureFlags(metric.enabledFeatureFlags),
      observedAt,
      ...(performanceEntryKey === undefined ? {} : { performanceEntryKey }),
    };
    insertSample(sample);
    if (performanceEntryKey !== undefined) {
      performanceEntryKeys.set(performanceEntryKey, observedAt);
    }
    return true;
  };

  const finalizeInsertedMetrics = (scheduledAt: number, notifyListeners = true): void => {
    const pruned = prune(scheduledAt);
    const sampleCapEvicted = evictSamplesOverCap();
    evictPerformanceEntryKeysOverCap();
    if ((pruned || sampleCapEvicted) && listeners.size === 0) {
      // Releasing cached identifiers is O(1); the next read rebuilds the full
      // snapshot lazily, while an observed store rebuilds once in publish().
      releaseCachedSampleContext(scheduledAt);
    }
    scheduleRetentionPrune(scheduledAt);
    snapshotDirty = true;
    if (notifyListeners && listeners.size > 0) {
      publishSnapshot(scheduledAt);
    }
  };

  const record = (metric: RendererLongTaskMetric): void => {
    if (!isLongTaskDuration(metric.durationMs)) {
      return;
    }
    const observedAt = readClock(true);
    if (observedAt === null) {
      return;
    }
    if (!insertMetric(metric, observedAt)) {
      return;
    }
    finalizeInsertedMetrics(observedAt);
  };

  const getSnapshot = (): RendererLongTaskTelemetrySnapshot => {
    if (snapshotDirty) {
      const snapshotAt = readClock(false);
      if (snapshotAt !== null) {
        currentSnapshot = buildSnapshot(snapshotAt);
        snapshotDirty = false;
      }
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

  const preparePerformanceEntry = (
    entry: PerformanceEntry,
    deliveredAt: number,
    elapsedMs: number,
    getContext: () => RendererLongTaskContext
  ): PreparedPerformanceEntry => {
    if (entry.entryType !== 'longtask' || !isLongTaskDuration(entry.duration)) {
      return { kind: 'ignored' };
    }
    if (!Number.isFinite(entry.startTime)) {
      return {
        error: new Error('PerformanceObserver longtask entry timing is unavailable.'),
        kind: 'invalid',
      };
    }
    const observedAt = deliveredAt - (elapsedMs - entry.startTime);
    if (!Number.isFinite(observedAt)) {
      return {
        error: new Error('PerformanceObserver longtask entry timing is unavailable.'),
        kind: 'invalid',
      };
    }
    if (observedAt < deliveredAt - windowMs) {
      return { kind: 'ignored' };
    }
    return {
      kind: 'metric',
      pendingMetric: {
        metric: { ...getContext(), durationMs: entry.duration },
        observedAt,
        performanceEntryKey: `${entry.startTime}:${entry.duration}`,
      },
    };
  };

  const safelyPreparePerformanceEntry = (
    entry: PerformanceEntry,
    deliveredAt: number,
    elapsedMs: number,
    getContext: () => RendererLongTaskContext
  ): PreparedPerformanceEntry => {
    try {
      return preparePerformanceEntry(entry, deliveredAt, elapsedMs, getContext);
    } catch (error) {
      return { error, kind: 'invalid' };
    }
  };

  const preparePerformanceEntryBatch = (
    entries: readonly PerformanceEntry[],
    deliveredAt: number,
    elapsedMs: number,
    getContext: () => RendererLongTaskContext
  ): PreparedPerformanceEntryBatch => {
    const pendingMetrics: PendingRendererLongTaskMetric[] = [];
    let hasPreparationError = false;
    let preparationError: unknown;
    for (const entry of entries) {
      const preparedEntry = safelyPreparePerformanceEntry(
        entry,
        deliveredAt,
        elapsedMs,
        getContext
      );
      if (preparedEntry.kind === 'invalid') {
        if (!hasPreparationError) {
          hasPreparationError = true;
          preparationError = preparedEntry.error;
        }
        continue;
      }
      if (preparedEntry.kind === 'metric') {
        pendingMetrics.push(preparedEntry.pendingMetric);
      }
    }
    return { hasPreparationError, pendingMetrics, preparationError };
  };

  const recordPerformanceEntries = (
    list: PerformanceObserverEntryList,
    getContext: () => RendererLongTaskContext
  ): boolean => {
    const deliveredAt = readClock(true);
    if (deliveredAt === null) {
      return false;
    }
    if (typeof performance === 'undefined') {
      throw new Error('Renderer long-task telemetry requires the Performance timing API.');
    }
    const elapsedMs = performance.now();
    if (!Number.isFinite(elapsedMs)) {
      throw new Error('PerformanceObserver longtask entry timing is unavailable.');
    }
    const { hasPreparationError, pendingMetrics, preparationError } = preparePerformanceEntryBatch(
      list.getEntries(),
      deliveredAt,
      elapsedMs,
      getContext
    );
    let insertedMetric = false;
    for (const pendingMetric of pendingMetrics) {
      insertedMetric =
        insertMetric(
          pendingMetric.metric,
          pendingMetric.observedAt,
          pendingMetric.performanceEntryKey
        ) || insertedMetric;
    }
    if (insertedMetric) {
      finalizeInsertedMetrics(deliveredAt, !hasPreparationError);
    }
    if (hasPreparationError) {
      throw preparationError;
    }
    return true;
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
        if (expectedAvailability === 'unsupported') {
          publishEmptySnapshot(currentSnapshot.snapshotAt);
          return;
        }
        publish();
      };
    let observer: PerformanceObserver | null = null;
    try {
      if (typeof PerformanceObserver === 'undefined') {
        availability = 'unsupported';
        unavailableReason = 'PerformanceObserver is unavailable in this renderer.';
        publishEmptySnapshot(currentSnapshot.snapshotAt);
        return disposeInactiveObservation('unsupported');
      }
      const supportedEntryTypes = PerformanceObserver.supportedEntryTypes;
      if (!(Array.isArray(supportedEntryTypes) && supportedEntryTypes.includes('longtask'))) {
        availability = 'unsupported';
        unavailableReason = 'This renderer does not support PerformanceObserver longtask entries.';
        publishEmptySnapshot(currentSnapshot.snapshotAt);
        return disposeInactiveObservation('unsupported');
      }
      const observationStartedAt = readClock(true);
      if (observationStartedAt === null) {
        return disposeInactiveObservation('failed');
      }

      const initialContext = getContext();
      currentFeatureFlagContextAvailability =
        initialContext.enabledFeatureFlags === null ? 'unavailable' : 'available';

      const createdObserver = new PerformanceObserver((list) => {
        try {
          if (recordPerformanceEntries(list, getContext)) {
            return;
          }
          createdObserver.disconnect();
          if (activeObserver === createdObserver) {
            activeObserver = null;
          }
        } catch (error) {
          createdObserver.disconnect();
          if (activeObserver === createdObserver) {
            activeObserver = null;
          }
          publishFailedSnapshot(error);
        }
      });
      observer = createdObserver;
      activeObserver = createdObserver;
      createdObserver.observe({ buffered: true, type: 'longtask' });
      availability = 'active';
      unavailableReason = null;
      publishSnapshot(observationStartedAt);
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
      publishFailedSnapshot(error);
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
    const resetAt = readClock(true);
    if (resetAt === null) {
      return;
    }
    publishSnapshot(resetAt);
  };

  return { getSnapshot, observe, record, reset, subscribe, updateContext };
}

export const rendererLongTaskTelemetry = createRendererLongTaskTelemetry();
