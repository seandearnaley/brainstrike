const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_SAMPLES = 512;
const LONG_TASK_MIN_DURATION_MS = 50;

export type RendererDiagnosticSurface =
  | 'explorer'
  | 'git'
  | 'notes'
  | 'settings'
  | 'terminal'
  | 'unknown';

export interface RendererLongTaskContext {
  readonly enabledFeatureFlags: readonly string[];
  readonly route: RendererDiagnosticSurface;
}

export interface RendererLongTaskMetric extends RendererLongTaskContext {
  readonly durationMs: number;
}

interface RendererLongTaskSample extends RendererLongTaskMetric {
  readonly observedAt: number;
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
  readonly observe: (getContext: () => RendererLongTaskContext) => () => void;
  readonly record: (metric: RendererLongTaskMetric) => void;
  readonly reset: () => void;
  readonly snapshot: () => RendererLongTaskTelemetrySnapshot;
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

export function createRendererLongTaskTelemetry(
  options: RendererLongTaskTelemetryOptions = {}
): RendererLongTaskTelemetry {
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const now = options.now ?? (() => Date.now());
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  if (!(Number.isInteger(maxSamples) && maxSamples > 0)) {
    throw new Error('Renderer long-task telemetry maxSamples must be a positive integer.');
  }
  if (!(Number.isFinite(windowMs) && windowMs > 0)) {
    throw new Error('Renderer long-task telemetry windowMs must be positive.');
  }

  let availability: RendererLongTaskTelemetrySnapshot['availability'] = 'idle';
  let samples: RendererLongTaskSample[] = [];
  let unavailableReason: string | null = null;

  const prune = (snapshotAt: number): void => {
    const threshold = snapshotAt - windowMs;
    samples = samples.filter((sample) => sample.observedAt >= threshold);
  };

  const record = (metric: RendererLongTaskMetric): void => {
    if (!(Number.isFinite(metric.durationMs) && metric.durationMs >= LONG_TASK_MIN_DURATION_MS)) {
      return;
    }
    const observedAt = now();
    samples.push({
      ...metric,
      enabledFeatureFlags: [...new Set(metric.enabledFeatureFlags)],
      observedAt,
    });
    prune(observedAt);
    if (samples.length > maxSamples) {
      samples.splice(0, samples.length - maxSamples);
    }
  };

  const snapshot = (): RendererLongTaskTelemetrySnapshot => {
    const snapshotAt = now();
    prune(snapshotAt);
    const durations = samples
      .map((sample) => sample.durationMs)
      .sort((left, right) => left - right);
    const countsByRoute = new Map<RendererDiagnosticSurface, number>();
    const countsByFeatureFlag = new Map<string, number>();
    for (const sample of samples) {
      countsByRoute.set(sample.route, (countsByRoute.get(sample.route) ?? 0) + 1);
      for (const flag of sample.enabledFeatureFlags) {
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
      featureFlags,
      maxDurationMs: durations.at(-1) ?? null,
      routes,
      sampleCount: samples.length,
      snapshotAt,
      unavailableReason,
      windowMs,
    };
  };

  const observe = (getContext: () => RendererLongTaskContext): (() => void) => {
    if (typeof PerformanceObserver === 'undefined') {
      availability = 'unsupported';
      unavailableReason = 'PerformanceObserver is unavailable in this renderer.';
      return () => undefined;
    }
    try {
      const supportedEntryTypes = PerformanceObserver.supportedEntryTypes;
      if (supportedEntryTypes.length > 0 && !supportedEntryTypes.includes('longtask')) {
        availability = 'unsupported';
        unavailableReason = 'This renderer does not support PerformanceObserver longtask entries.';
        return () => undefined;
      }

      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType !== 'longtask' || entry.duration < LONG_TASK_MIN_DURATION_MS) {
            continue;
          }
          record({ ...getContext(), durationMs: entry.duration });
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
      availability = 'active';
      unavailableReason = null;
      return () => {
        observer.disconnect();
      };
    } catch (error) {
      availability = 'failed';
      unavailableReason = error instanceof Error ? error.message : String(error);
      return () => undefined;
    }
  };

  const reset = (): void => {
    availability = 'idle';
    samples = [];
    unavailableReason = null;
  };

  return { observe, record, reset, snapshot };
}

export const rendererLongTaskTelemetry = createRendererLongTaskTelemetry();
