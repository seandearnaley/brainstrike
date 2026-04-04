import { afterEach, describe, expect, it, vi } from 'vitest';

import { yieldToBrowser } from '../recursive-selection-utils';

describe('recursive-selection-utils', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses timeout-based yielding even when requestAnimationFrame exists', async () => {
    vi.useFakeTimers();
    const requestAnimationFrameSpy = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameSpy);

    const yielded = vi.fn();
    const promise = yieldToBrowser().then(yielded);

    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
    expect(yielded).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    await promise;

    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
    expect(yielded).toHaveBeenCalledTimes(1);
  });
});
