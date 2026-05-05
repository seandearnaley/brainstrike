import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAppState } from '../app-state';

describe('resetAppState', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('deletes stale web E2E IndexedDB databases without deleting the active session database', async () => {
    const deletedDatabases: string[] = [];
    const removeItem = vi.fn();
    const deleteCache = vi.fn();
    const evaluate = vi.fn(async (callback, args) => {
      await callback(args);
    });
    const page = { evaluate } as unknown as Page;

    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => 'idb://web-e2e-active'),
    });
    vi.stubGlobal('localStorage', {
      removeItem,
    });
    vi.stubGlobal('caches', {
      delete: deleteCache,
      keys: vi.fn(async () => ['brainstrike-cache']),
    });
    vi.stubGlobal('indexedDB', {
      databases: vi.fn(async () => [
        { name: 'web-e2e-active' },
        { name: 'web-e2e-stale' },
        { name: 'user-data' },
      ]),
      deleteDatabase: vi.fn((name: string) => {
        deletedDatabases.push(name);
        const request: {
          onblocked?: () => void;
          onerror?: () => void;
          onsuccess?: () => void;
        } = {};
        queueMicrotask(() => request.onsuccess?.());
        return request;
      }),
    });

    await resetAppState(page);

    expect(deletedDatabases).toEqual(['brainstrike-file-handles', 'web-e2e-stale']);
    expect(deleteCache).toHaveBeenCalledWith('brainstrike-cache');
    expect(removeItem).toHaveBeenCalledWith('background-indexing-preferences.v1');
  });
});
