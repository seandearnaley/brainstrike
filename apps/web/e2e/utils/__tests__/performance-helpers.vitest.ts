import type { Locator } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_THRESHOLDS,
  detectEnvironment,
  getEnvironmentThresholds,
  PERFORMANCE_THRESHOLDS,
} from '../performance-config';
import {
  measureLocatorInteractionFrames,
  measureNamedCheckboxInteractionFrame,
} from '../performance-helpers';

function createLocator(elements: unknown[]): Locator {
  return {
    evaluateAll: async <Result, Arg>(
      pageFunction: (pageElements: Element[], arg: Arg) => Result | Promise<Result>,
      arg: Arg
    ): Promise<Result> => await pageFunction(elements as Element[], arg),
  } as unknown as Locator;
}

function createCheckbox(
  initialChecked = false,
  accessibleName?: string
): {
  click: ReturnType<typeof vi.fn>;
  disabled: boolean;
  getAttribute: (name: string) => string | null;
  isConnected: boolean;
} {
  let checked = initialChecked;
  return {
    click: vi.fn(() => {
      checked = !checked;
    }),
    disabled: false,
    getAttribute: (name: string) => {
      if (name === 'aria-checked') {
        return String(checked);
      }
      if (name === 'aria-label') {
        return accessibleName ?? null;
      }
      return null;
    },
    isConnected: true,
  };
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
    expect(PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_AVERAGE_MAX_MS).toBeGreaterThan(0);
    expect(PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_MAX_MS).toBeGreaterThan(0);
    expect(PERFORMANCE_THRESHOLDS.CHECKBOX_FRAME_TOTAL_MAX_MS).toBeGreaterThan(0);
    expect(PERFORMANCE_THRESHOLDS.MEMORY_TOTAL_MAX_MB).toBeGreaterThan(0);
  });

  it('measures checkbox interactions inside the browser through the next painted frame', async () => {
    const first = createCheckbox();
    const second = createCheckbox();
    const third = createCheckbox();
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(32)
      .mockReturnValueOnce(32)
      .mockReturnValueOnce(64);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const metrics = await measureLocatorInteractionFrames(createLocator([first, second, third]), {
      count: 2,
      kind: 'click-each',
    });

    expect(first.click).toHaveBeenCalledOnce();
    expect(second.click).toHaveBeenCalledOnce();
    expect(third.click).not.toHaveBeenCalled();
    expect(metrics).toEqual({
      averageDurationMs: 32,
      maxDurationMs: 32,
      samplesMs: [32, 32],
      totalDurationMs: 64,
    });
  });

  it('fails visibly when the requested interaction count exceeds the locator results', async () => {
    await expect(
      measureLocatorInteractionFrames(createLocator([createCheckbox()]), {
        count: 2,
        kind: 'click-each',
      })
    ).rejects.toThrow('requested 2 elements, but the locator matched 1');
  });

  it('fails visibly instead of measuring a disabled checkbox no-op', async () => {
    const checkbox = createCheckbox();
    checkbox.disabled = true;

    await expect(
      measureLocatorInteractionFrames(createLocator([checkbox]), {
        count: 1,
        kind: 'click-each',
      })
    ).rejects.toThrow('disabled');
  });

  it('fails visibly instead of measuring a detached checkbox no-op', async () => {
    const checkbox = createCheckbox();
    checkbox.isConnected = false;

    await expect(
      measureLocatorInteractionFrames(createLocator([checkbox]), {
        count: 1,
        kind: 'click-each',
      })
    ).rejects.toThrow('detached');
  });

  it('rejects the retained-element boundary when a clicked checkbox row is replaced', async () => {
    const checkbox = createCheckbox();
    checkbox.click = vi.fn(() => {
      checkbox.isConnected = false;
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    await expect(
      measureLocatorInteractionFrames(createLocator([checkbox]), {
        count: 1,
        kind: 'click-each',
      })
    ).rejects.toThrow('detached after its click');
  });

  it('re-resolves a replaced checkbox by accessible name after paint', async () => {
    const replacement = createCheckbox(true, 'Select folder');
    let activeCheckbox = createCheckbox(false, 'Select folder');
    activeCheckbox.click = vi.fn(() => {
      activeCheckbox.isConnected = false;
      activeCheckbox = replacement;
    });
    const container = {
      querySelectorAll: () => [activeCheckbox],
    };
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(32);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const metrics = await measureNamedCheckboxInteractionFrame(createLocator([container]), {
      name: 'Select folder',
    });

    expect(metrics).toEqual({
      averageDurationMs: 32,
      maxDurationMs: 32,
      samplesMs: [32],
      totalDurationMs: 32,
    });
  });

  it('rejects a named checkbox whose checked state never changes (silent no-op)', async () => {
    // A click that leaves the observable checked state identical means the
    // interaction did not complete — the boundary must refuse to time it
    // rather than report a plausible-looking frame sample.
    const checkbox = createCheckbox(false, 'Select folder');
    checkbox.click = vi.fn(() => {
      // Deliberately does NOT toggle checked state.
    });
    const container = {
      querySelectorAll: () => [checkbox],
    };
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    await expect(
      measureNamedCheckboxInteractionFrame(createLocator([container]), {
        name: 'Select folder',
      })
    ).rejects.toThrow('did not change checked state');
  });

  it('fails visibly when a click does not change checked state', async () => {
    const checkbox = createCheckbox();
    checkbox.click = vi.fn();

    await expect(
      measureLocatorInteractionFrames(createLocator([checkbox]), {
        count: 1,
        kind: 'click-each',
      })
    ).rejects.toThrow('did not change checked state');
  });

  it('observes checked state on native checkboxes without aria-checked', async () => {
    const checkbox = {
      checked: false,
      click: vi.fn(() => {
        checkbox.checked = true;
      }),
      disabled: false,
      getAttribute: () => null,
      isConnected: true,
    };
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(32);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    await expect(
      measureLocatorInteractionFrames(createLocator([checkbox]), {
        count: 1,
        kind: 'click-each',
      })
    ).resolves.toMatchObject({ samplesMs: [32] });
  });

  it('measures scroll interactions through each painted frame', async () => {
    const scrollContainer = { clientHeight: 200, scrollHeight: 1000, scrollTop: 0 };
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(40);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const metrics = await measureLocatorInteractionFrames(createLocator([scrollContainer]), {
      kind: 'scroll-first',
      steps: 2,
    });

    expect(scrollContainer.scrollTop).toBe(800);
    expect(metrics).toEqual({
      averageDurationMs: 20,
      maxDurationMs: 20,
      samplesMs: [20, 20],
      totalDurationMs: 40,
    });
  });

  it('fails visibly when the scroll target is not scrollable', async () => {
    await expect(
      measureLocatorInteractionFrames(
        createLocator([{ clientHeight: 200, scrollHeight: 200, scrollTop: 0 }]),
        {
          kind: 'scroll-first',
          steps: 2,
        }
      )
    ).rejects.toThrow('not scrollable');
  });
});
