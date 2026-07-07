let performanceMeasureGuardInstalled = false;

function isDataCloneMeasureError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'DataCloneError';
  }
  return error instanceof Error && error.name === 'DataCloneError';
}

function clearPerformanceEntries(perf: Performance): void {
  try {
    perf.clearMeasures();
    perf.clearMarks();
  } catch {
    // Ignore cleanup errors; guard remains best-effort.
  }
}

/**
 * Guards performance.measure against known DataCloneError crashes under heavy
 * renderer load (for example when React dev instrumentation emits oversized
 * measure detail payloads).
 */
export function installPerformanceMeasureGuard(): void {
  if (performanceMeasureGuardInstalled) {
    return;
  }

  if (typeof globalThis.performance === 'undefined') {
    return;
  }

  const perf = globalThis.performance;
  if (typeof perf.measure !== 'function') {
    return;
  }

  const originalMeasure = perf.measure.bind(perf);
  const guardedMeasure: typeof perf.measure = ((...args: Parameters<typeof perf.measure>) => {
    try {
      return originalMeasure(...args);
    } catch (error) {
      if (isDataCloneMeasureError(error)) {
        clearPerformanceEntries(perf);
        return undefined as unknown as ReturnType<typeof perf.measure>;
      }
      throw error;
    }
  }) as typeof perf.measure;

  try {
    perf.measure = guardedMeasure;
    performanceMeasureGuardInstalled = true;
    return;
  } catch {
    // Continue to descriptor-based install path.
  }

  try {
    Object.defineProperty(perf, 'measure', {
      configurable: true,
      value: guardedMeasure,
      writable: true,
    });
    performanceMeasureGuardInstalled = true;
  } catch {
    // Some runtimes expose non-writable/non-configurable performance implementations.
  }
}
