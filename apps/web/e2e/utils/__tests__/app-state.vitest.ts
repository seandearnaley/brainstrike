import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { resetAppState } from '../app-state';

describe('resetAppState', () => {
  it('removes known localStorage keys', async () => {
    const evaluate = vi.fn().mockResolvedValue(undefined);
    const page = { evaluate } as unknown as Page;

    await resetAppState(page);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]).toBeDefined();
    expect(typeof evaluate.mock.calls[0]?.[0]).toBe('function');
    expect(evaluate.mock.calls[0]?.[1]).toMatchObject({
      keys: expect.arrayContaining([
        'background-indexing-preferences.v1',
        'vector-status-ui.v1',
        'vector-preferences.v1',
        'brainstrike.activeEmbeddingSetId',
      ]),
    });
  });
});
