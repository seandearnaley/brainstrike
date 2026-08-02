const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_SAMPLES = 512;
const LONG_TASK_MIN_DURATION_MS = 50;
const PERFORMANCE_ENTRY_COMPLETION_TOLERANCE_MS = 1;

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

type PreparedPerformanceEntryBatch =
  | {
      readonly kind: 'invalid';
      readonly pendingMetrics: readonly PendingRendererLongTaskMetric[];
      readonly preparationError: unknown;
    }
  | {
      readonly kind: 'valid';
      readonly pendingMetrics: readonly PendingRendererLongTaskMetric[];
    };

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
  readonly featureFlagContextSampleCount: number;
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
  let pendingRetainedContextRelease = false;
  let retentionTimer: ReturnType<typeof setTimeout> | null = null;
  let samples: RendererLongTaskSample[] = [];
  let unavailableReason: string | null = null;
  let lastSuccessfulClockAt = 0;

  const readNow = (): number => {
    const snapshotAt = now();
    if (!Number.isFinite(snapshotAt)) {
      throw new Error('Renderer long-task telemetry clock must return a finite timestamp.');
    }
    return snapshotAt;
  };

  const prune = (snapshotAt: number): boolean => {
    const threshold = snapshotAt - windowMs;
    const firstRetainedIndex = samples.findIndex((sample) => sample.observedAt >= threshold);
    const samplesPruned = firstRetainedIndex !== 0 && samples.length > 0;
    if (samplesPruned) {
      samples = firstRetainedIndex < 0 ? [] : samples.slice(firstRetainedIndex);
    }
    for (const [key, observedAt] of performanceEntryKeys) {
      if (observedAt < threshold) {
        performanceEntryKeys.delete(key);
      }
    }
    return samplesPruned;
  };

  const buildSnapshot = (snapshotAt: number): RendererLongTaskTelemetrySnapshot => {
    const threshold = snapshotAt - windowMs;
    const currentSamples = samples.filter((sample) => sample.observedAt >= threshold);
    const durations = currentSamples
      .map((sample) => sample.durationMs)
      .sort((left, right) => left - right);
    const countsByRoute = new Map<RendererDiagnosticSurface, number>();
    const countsByFeatureFlag = new Map<string, number>();
    let featureFlagContextSampleCount = 0;
    let hasAvailableFeatureFlagContext = false;
    let hasUnavailableFeatureFlagContext = false;
    for (const sample of currentSamples) {
      countsByRoute.set(sample.route, (countsByRoute.get(sample.route) ?? 0) + 1);
      if (sample.enabledFeatureFlags === null) {
        hasUnavailableFeatureFlagContext = true;
      } else {
        hasAvailableFeatureFlagContext = true;
        featureFlagContextSampleCount += 1;
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
      featureFlagContextSampleCount,
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
    featureFlagContextSampleCount: 0,
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
    pendingRetainedContextRelease = false;
    samples = [];
    performanceEntryKeys.clear();
  };

  const releasePendingRetainedSampleContext = (): void => {
    if (!pendingRetainedContextRelease) {
      return;
    }
    releaseRetainedSampleContext();
  };

  const resolveFailedSnapshotClock = (
    failureReason: string,
    retainedContextDisposition: 'defer' | 'preserve' | 'release',
    clockAlreadyFailed: boolean,
    knownSnapshotAt?: number
  ): {
    readonly reason: string;
    readonly shouldReleaseRetainedContext: boolean;
    readonly snapshotAt: number;
  } => {
    if (knownSnapshotAt !== undefined) {
      lastSuccessfulClockAt = knownSnapshotAt;
      return {
        reason: failureReason,
        shouldReleaseRetainedContext: retainedContextDisposition === 'release',
        snapshotAt: knownSnapshotAt,
      };
    }
    if (clockAlreadyFailed) {
      return {
        reason: failureReason,
        shouldReleaseRetainedContext: retainedContextDisposition === 'release',
        snapshotAt: lastSuccessfulClockAt,
      };
    }
    try {
      const snapshotAt = readNow();
      lastSuccessfulClockAt = snapshotAt;
      return {
        reason: failureReason,
        shouldReleaseRetainedContext: retainedContextDisposition === 'release',
        snapshotAt,
      };
    } catch (clockError) {
      const clockFailureReason = readErrorMessage(clockError);
      return {
        reason:
          clockFailureReason === failureReason
            ? failureReason
            : `${failureReason} (clock unavailable: ${clockFailureReason})`,
        shouldReleaseRetainedContext: retainedContextDisposition !== 'defer',
        snapshotAt: lastSuccessfulClockAt,
      };
    }
  };

  const setFailedSnapshot = (
    error: unknown,
    notifyListeners: boolean,
    retainedContextDisposition: 'defer' | 'preserve' | 'release' = 'preserve',
    clockAlreadyFailed = false,
    knownSnapshotAt?: number
  ): void => {
    availability = 'failed';
    const failureReason = readErrorMessage(error);
    const clockResolution = resolveFailedSnapshotClock(
      failureReason,
      retainedContextDisposition,
      clockAlreadyFailed,
      knownSnapshotAt
    );
    unavailableReason = clockResolution.reason;
    if (clockResolution.shouldReleaseRetainedContext) {
      releaseRetainedSampleContext();
    } else if (retainedContextDisposition === 'defer') {
      pendingRetainedContextRelease = true;
    }
    currentSnapshot =
      retainedContextDisposition === 'defer'
        ? buildEmptySnapshot(clockResolution.snapshotAt)
        : buildSnapshot(clockResolution.snapshotAt);
    snapshotDirty = false;
    if (notifyListeners) {
      for (const listener of listeners) {
        listener();
      }
    }
  };

  const publishFailedSnapshot = (error: unknown, knownSnapshotAt?: number): void => {
    setFailedSnapshot(error, true, 'preserve', false, knownSnapshotAt);
  };

  const readClock = (
    notifyListeners: boolean,
    deferRetainedContextRelease = false
  ): number | null => {
    if (!deferRetainedContextRelease) {
      releasePendingRetainedSampleContext();
    }
    try {
      const snapshotAt = readNow();
      lastSuccessfulClockAt = snapshotAt;
      return snapshotAt;
    } catch (error) {
      setFailedSnapshot(
        error,
        notifyListeners,
        deferRetainedContextRelease ? 'defer' : 'release',
        true
      );
      return null;
    }
  };

  const publish = (): void => {
    releasePendingRetainedSampleContext();
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
    releasePendingRetainedSampleContext();
    if (availability === 'failed' || availability === 'unsupported') {
      throw new Error(
        `Cannot record renderer long-task telemetry while observation is ${availability}.`
      );
    }
    if (!Number.isFinite(metric.durationMs)) {
      throw new Error('Renderer long-task telemetry duration must be finite.');
    }
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
      const snapshotAt = readClock(false, true);
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
    if (entry.entryType !== 'longtask') {
      return { kind: 'ignored' };
    }
    if (!Number.isFinite(entry.duration)) {
      return {
        error: new Error('PerformanceObserver longtask entry duration is unavailable.'),
        kind: 'invalid',
      };
    }
    if (entry.duration < 0) {
      return {
        error: new Error('PerformanceObserver longtask entry duration cannot be negative.'),
        kind: 'invalid',
      };
    }
    if (!isLongTaskDuration(entry.duration)) {
      return { kind: 'ignored' };
    }
    if (!Number.isFinite(entry.startTime)) {
      return {
        error: new Error('PerformanceObserver longtask entry start time is unavailable.'),
        kind: 'invalid',
      };
    }
    if (entry.startTime < 0) {
      return {
        error: new Error('PerformanceObserver longtask entry start time cannot be negative.'),
        kind: 'invalid',
      };
    }
    const completedAt = entry.startTime + entry.duration;
    // Buffered entries may be stale, but a completed entry cannot arrive before
    // its end time on the same Performance timeline. One millisecond covers
    // independent sub-millisecond rounding; larger overshoots remain malformed.
    if (completedAt > elapsedMs + PERFORMANCE_ENTRY_COMPLETION_TOLERANCE_MS) {
      return {
        error: new Error('PerformanceObserver longtask entry completed after delivery.'),
        kind: 'invalid',
      };
    }
    const observedAt = deliveredAt - (elapsedMs - entry.startTime);
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
    const preparationErrors: unknown[] = [];
    for (const entry of entries) {
      const preparedEntry = safelyPreparePerformanceEntry(
        entry,
        deliveredAt,
        elapsedMs,
        getContext
      );
      if (preparedEntry.kind === 'invalid') {
        preparationErrors.push(preparedEntry.error);
        continue;
      }
      if (preparedEntry.kind === 'metric') {
        pendingMetrics.push(preparedEntry.pendingMetric);
      }
    }
    if (preparationErrors.length === 0) {
      return { kind: 'valid', pendingMetrics };
    }
    const distinctPreparationErrors = new Map<string, unknown>();
    for (const error of preparationErrors) {
      const message = readErrorMessage(error);
      if (!distinctPreparationErrors.has(message)) {
        distinctPreparationErrors.set(message, error);
      }
    }
    const distinctPreparationErrorMessages = [...distinctPreparationErrors.keys()];
    const preparationError =
      distinctPreparationErrorMessages.length > 1
        ? new AggregateError(
            distinctPreparationErrors.values(),
            `PerformanceObserver longtask batch contains multiple invalid entries: ${distinctPreparationErrorMessages.join(' ')}`
          )
        : preparationErrors[0];
    return {
      kind: 'invalid',
      pendingMetrics,
      preparationError,
    };
  };

  const insertPreparedPerformanceEntryBatch = (
    preparedBatch: PreparedPerformanceEntryBatch,
    deliveredAt: number
  ): void => {
    let insertedMetric = false;
    try {
      for (const pendingMetric of preparedBatch.pendingMetrics) {
        insertedMetric =
          insertMetric(
            pendingMetric.metric,
            pendingMetric.observedAt,
            pendingMetric.performanceEntryKey
          ) || insertedMetric;
      }
    } catch (error) {
      if (insertedMetric) {
        finalizeInsertedMetrics(deliveredAt, false);
      }
      throw error;
    }
    if (insertedMetric) {
      finalizeInsertedMetrics(deliveredAt, preparedBatch.kind === 'valid');
    }
    if (preparedBatch.kind === 'invalid') {
      throw preparedBatch.preparationError;
    }
  };

  const recordPerformanceEntries = (
    list: PerformanceObserverEntryList,
    getContext: () => RendererLongTaskContext
  ): boolean => {
    const deliveredAt = readClock(true);
    if (deliveredAt === null) {
      return false;
    }
    try {
      if (typeof performance === 'undefined') {
        throw new Error('Renderer long-task telemetry requires the Performance timing API.');
      }
      // Reading this after deliveredAt biases mapped occurrence times slightly
      // earlier, which is the conservative direction for retention.
      const elapsedMs = performance.now();
      if (!Number.isFinite(elapsedMs)) {
        throw new Error('PerformanceObserver longtask entry timing is unavailable.');
      }
      const preparedBatch = preparePerformanceEntryBatch(
        list.getEntries(),
        deliveredAt,
        elapsedMs,
        getContext
      );
      insertPreparedPerformanceEntryBatch(preparedBatch, deliveredAt);
      return true;
    } catch (error) {
      publishFailedSnapshot(error, deliveredAt);
      return false;
    }
  };

  const publishIdleSnapshotIfClockRecovered = (): void => {
    releasePendingRetainedSampleContext();
    try {
      const snapshotAt = readNow();
      lastSuccessfulClockAt = snapshotAt;
      availability = 'idle';
      unavailableReason = null;
      publishSnapshot(snapshotAt);
    } catch {
      // Disposal cannot claim recovery while the clock remains unusable.
      // Keep the precise observer failure latched until a later operation.
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
        if (expectedAvailability === 'unsupported') {
          availability = 'idle';
          unavailableReason = null;
          releaseRetainedSampleContext();
          publishEmptySnapshot(lastSuccessfulClockAt);
          return;
        }
        publishIdleSnapshotIfClockRecovered();
      };
    let observer: PerformanceObserver | null = null;
    try {
      if (typeof PerformanceObserver === 'undefined') {
        availability = 'unsupported';
        unavailableReason = 'PerformanceObserver is unavailable in this renderer.';
        releaseRetainedSampleContext();
        publishEmptySnapshot(lastSuccessfulClockAt);
        return disposeInactiveObservation('unsupported');
      }
      const supportedEntryTypes = PerformanceObserver.supportedEntryTypes;
      if (!(Array.isArray(supportedEntryTypes) && supportedEntryTypes.includes('longtask'))) {
        availability = 'unsupported';
        unavailableReason = 'This renderer does not support PerformanceObserver longtask entries.';
        releaseRetainedSampleContext();
        publishEmptySnapshot(lastSuccessfulClockAt);
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
          publishIdleSnapshotIfClockRecovered();
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
