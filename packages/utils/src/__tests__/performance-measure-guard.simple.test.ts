import { afterEach, describe, expect, it, vi } from 'vitest';

const originalMeasure = globalThis.performance.measure;

function setMeasureImplementation(impl: typeof globalThis.performance.measure): void {
  Object.defineProperty(globalThis.performance, 'measure', {
    configurable: true,
    value: impl,
    writable: true,
  });
}

describe('Performance Measure Guard - Simple Tests', () => {
  afterEach(() => {
    setMeasureImplementation(originalMeasure);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('should swallow DataCloneError from performance.measure', async () => {
    const throwingMeasure = vi.fn(() => {
      const error = new Error('Data cannot be cloned, out of memory.');
      error.name = 'DataCloneError';
      throw error;
    }) as typeof globalThis.performance.measure;
    setMeasureImplementation(throwingMeasure);
    const clearMeasuresSpy = vi.spyOn(globalThis.performance, 'clearMeasures');
    const clearMarksSpy = vi.spyOn(globalThis.performance, 'clearMarks');

    const { installPerformanceMeasureGuard } = await import('../performance-measure-guard');
    installPerformanceMeasureGuard();

    expect(() => {
      globalThis.performance.measure('react-render');
    }).not.toThrow();
    expect(throwingMeasure).toHaveBeenCalledTimes(1);
    expect(clearMeasuresSpy).toHaveBeenCalledTimes(1);
    expect(clearMarksSpy).toHaveBeenCalledTimes(1);
  });

  it('should rethrow non-DataCloneError failures', async () => {
    const throwingMeasure = vi.fn(() => {
      throw new Error('generic failure');
    }) as typeof globalThis.performance.measure;
    setMeasureImplementation(throwingMeasure);

    const { installPerformanceMeasureGuard } = await import('../performance-measure-guard');
    installPerformanceMeasureGuard();

    expect(() => {
      globalThis.performance.measure('regular-measure');
    }).toThrowError('generic failure');
    expect(throwingMeasure).toHaveBeenCalledTimes(1);
  });

  it('should be safe to call multiple times', async () => {
    const passthroughMeasure = vi.fn(
      () => undefined as unknown as ReturnType<typeof originalMeasure>
    ) as typeof globalThis.performance.measure;
    setMeasureImplementation(passthroughMeasure);

    const { installPerformanceMeasureGuard } = await import('../performance-measure-guard');
    installPerformanceMeasureGuard();
    installPerformanceMeasureGuard();
    installPerformanceMeasureGuard();

    globalThis.performance.measure('idempotent');
    expect(passthroughMeasure).toHaveBeenCalledTimes(1);
  });
});
