import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { resetAppState } from '../app-state';

describe('resetAppState', () => {
  it('removes known localStorage keys', async () => {
    const evaluate = vi.fn().mockResolvedValue(undefined);
    const page = { evaluate } as unknown as Page;

    await resetAppState(page);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]).toBeDefined();
    expect(typeof evaluate.mock.calls[0]?.[0]).toBe('function');
  });
});
