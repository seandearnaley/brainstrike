import type { Locator } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_THRESHOLDS,
  detectEnvironment,
  getEnvironmentThresholds,
  PERFORMANCE_THRESHOLDS,
} from '../performance-config';
import { measureLocatorInteractionFrames } from '../performance-helpers';

function createLocator(elements: unknown[]): Locator {
  return {
    evaluateAll: async <Result, Arg>(
      pageFunction: (pageElements: Element[], arg: Arg) => Result | Promise<Result>,
      arg: Arg
    ): Promise<Result> => await pageFunction(elements as Element[], arg),
  } as unknown as Locator;
}

describe('performance helpers (unit)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('detectEnvironment returns local by default', () => {
    const env = detectEnvironment();
    expect(['local', 'ci', 'github-actions']).toContain(env);
  });

  it('getEnvironmentThresholds scales by environment', () => {
    const local = getEnvironmentThresholds('local');
    const ci = getEnvironmentThresholds('ci');
    expect(ci.TREE_LOAD_MAX_MS).toBeGreaterThanOrEqual(BASE_THRESHOLDS.TREE_LOAD_MAX_MS);
    expect(local.TREE_LOAD_MAX_MS).toBeGreaterThan(0);
  });

  it('PERFORMANCE_THRESHOLDS is defined', () => {
    expect(PERFORMANCE_THRESHOLDS.MEMORY_TOTAL_MAX_MB).toBeGreaterThan(0);
  });

  it('measures checkbox interactions inside the browser through the next painted frame', async () => {
    const clickFirst = vi.fn();
    const clickSecond = vi.fn();
    const clickThird = vi.fn();
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(32)
      .mockReturnValueOnce(32)
      .mockReturnValueOnce(64);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const metrics = await measureLocatorInteractionFrames(
      createLocator([{ click: clickFirst }, { click: clickSecond }, { click: clickThird }]),
      { count: 2, kind: 'click-each' }
    );

    expect(clickFirst).toHaveBeenCalledOnce();
    expect(clickSecond).toHaveBeenCalledOnce();
    expect(clickThird).not.toHaveBeenCalled();
    expect(metrics).toEqual({
      averageDurationMs: 32,
      maxDurationMs: 32,
      samplesMs: [32, 32],
      totalDurationMs: 64,
    });
  });

  it('fails visibly when the requested interaction count exceeds the locator results', async () => {
    await expect(
      measureLocatorInteractionFrames(createLocator([{ click: vi.fn() }]), {
        count: 2,
        kind: 'click-each',
      })
    ).rejects.toThrow('requested 2 elements, but the locator matched 1');
  });
});
