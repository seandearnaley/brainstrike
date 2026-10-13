import type { ForgePrCacheEntry, ForgePrUpdatedEvent, ForgeResult } from '@brainstrike/types';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ForgeBridge } from '../forge/forge-bridge';
import { useForgePrCache } from '../hooks/use-forge-pr-cache';

const row: ForgePrCacheEntry = {
  branch: 'main',
  checksRollup: 'passing',
  isDraft: true,
  number: 42,
  repoCommonDir: '/disposable/repo/.git',
  state: 'open',
  url: 'https://github.example/acme/repo/pull/42',
};
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'forge');
});
function bridge(cacheSnapshot: ForgeBridge['cacheSnapshot']) {
  let update: ((event: ForgePrUpdatedEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const value: ForgeBridge = {
    cacheSnapshot,
    identity: vi.fn(),
    onPrUpdated: (callback) => {
      update = callback;
      return unsubscribe;
    },
    prStatus: vi.fn(),
    refresh: vi.fn(),
  };
  Object.assign(window, { forge: value });
  return {
    unsubscribe,
    update: () =>
      update?.({
        branch: row.branch,
        generation: 1,
        pullRequest: null,
        repoCommonDir: row.repoCommonDir,
        transitions: [],
      }),
  };
}

test('reads current writer snapshot without a PG handle and refreshes on the existing publisher event', async () => {
  const cacheSnapshot = vi
    .fn<ForgeBridge['cacheSnapshot']>()
    .mockResolvedValueOnce({ ok: true, value: [row] })
    .mockResolvedValueOnce({ ok: true, value: [] });
  const fixture = bridge(cacheSnapshot);
  const hook = renderHook(() => useForgePrCache({ enabled: true }));
  await waitFor(() => expect(hook.result.current.byRepoBranch.size).toBe(1));
  act(fixture.update);
  await waitFor(() => expect(hook.result.current.byRepoBranch.size).toBe(0));
  expect(cacheSnapshot).toHaveBeenCalledTimes(2);
  hook.unmount();
  expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
});

test('a stale snapshot cannot overwrite the newer event-driven read and failures remain visible', async () => {
  const old = Promise.withResolvers<ForgeResult<readonly ForgePrCacheEntry[]>>();
  const cacheSnapshot = vi
    .fn<ForgeBridge['cacheSnapshot']>()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ error: 'writer unavailable', ok: false });
  const fixture = bridge(cacheSnapshot);
  const hook = renderHook(() => useForgePrCache({ enabled: true }));
  act(fixture.update);
  await waitFor(() => expect(hook.result.current.error?.message).toBe('writer unavailable'));
  await act(async () => {
    old.resolve({ ok: true, value: [row] });
    await old.promise;
  });
  expect(hook.result.current.byRepoBranch.size).toBe(0);
  expect(hook.result.current.error?.message).toBe('writer unavailable');
});

test('web capability absence has no database query or fabricated observation', () => {
  const hook = renderHook(() => useForgePrCache({ enabled: true }));
  expect(hook.result.current).toEqual({ byRepoBranch: new Map(), error: null, loading: false });
});
