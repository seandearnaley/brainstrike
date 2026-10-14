import type { DbHandle } from '@brainstrike/db/react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThreadRoots } from '../hooks/use-thread-roots';
import {
  notifyRootRegistered,
  resetRootRegistrationEventsForTests,
} from '../roots/root-registration-events';

// Same identity and roots-reader row shape as the candidate-036 reconnect incident.
const ROOT_ID = '01119602-b67e-4e7e-83ad-ab54def811ef';
const ROOT_PATH = '/fixture/root';
const row = { displayName: 'root', id: ROOT_ID, path: ROOT_PATH, status: 'disconnected' };
const secondaryRootIds = [ROOT_ID];
const params = {
  mountedKey: '',
  primaryRootId: ROOT_ID,
  secondaryRootIds,
  secondaryRootIdsKey: ROOT_ID,
};
function mount(query: ReturnType<typeof vi.fn>, mountedKey = '') {
  const database = { query } as unknown as DbHandle;
  return renderHook(
    (props: { mountedKey: string }) => useThreadRoots({ ...params, ...props, database }),
    { initialProps: { mountedKey } }
  );
}

beforeEach(() => resetRootRegistrationEventsForTests());

describe('committed registration refreshes bound folder status', () => {
  it('rereads after a delayed writer commits without another mount or binding change', async () => {
    let status = 'disconnected';
    const query = vi.fn(async () => ({ rows: [{ ...row, status }] }));
    const { result, rerender } = mount(query);
    await waitFor(() => expect(result.current.primaryRemoved).toBe(true));
    rerender({ mountedKey: ROOT_PATH });
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    expect(result.current.primaryRemoved).toBe(true);
    // The mounted descriptor is already published, but the registration writer
    // commits later and emits its existing post-write notification.
    await act(async () => {
      status = 'live';
      notifyRootRegistered([ROOT_ID, ROOT_PATH]);
    });
    await waitFor(() => expect(result.current.primaryRemoved).toBe(false));
    expect(result.current.loadedSecondaryRoots).toEqual([
      { displayName: 'root', path: ROOT_PATH, rootId: ROOT_ID },
    ]);
  });

  it('does not let an older disconnected read overwrite the post-registration result', async () => {
    const oldRead = Promise.withResolvers<{ rows: (typeof row)[] }>();
    const query = vi
      .fn()
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValue({
        rows: [{ ...row, status: 'live' }],
      });
    const { result } = mount(query, ROOT_PATH);
    await act(async () => notifyRootRegistered([ROOT_ID, ROOT_PATH]));
    await waitFor(() => expect(result.current.loadedSecondaryRoots).toHaveLength(1));
    await act(async () => oldRead.resolve({ rows: [row] }));
    expect(result.current.primaryRemoved).toBe(false);
    expect(result.current.loadedSecondaryRoots[0]?.removed).toBeUndefined();
  });

  it('surfaces a failed refresh instead of presenting it as a successful empty read', async () => {
    const failure = new Error('recorded roots read failure');
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockRejectedValue(failure);
    const { result } = mount(query);
    await waitFor(() => expect(result.current.primaryRemoved).toBe(true));
    await act(async () => notifyRootRegistered([ROOT_ID, ROOT_PATH]));
    await waitFor(() => expect(result.current.secondaryRootsStatus).toBe('error'));
  });

  it('unsubscribes and discards pending reads when the reader unmounts', async () => {
    const pending = Promise.withResolvers<{ rows: (typeof row)[] }>();
    const query = vi.fn().mockReturnValue(pending.promise);
    const { result, unmount } = mount(query);
    const before = result.current;
    unmount();
    await act(async () => {
      notifyRootRegistered([ROOT_ID, ROOT_PATH]);
      pending.resolve({ rows: [row] });
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(before);
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'threadGroups');
});

it('reads retained native roots and reconnect status without a database provider', async () => {
  let status = 'disconnected';
  const readRoots = vi.fn(async () => [{ ...row, status }]);
  Object.defineProperty(window, 'threadGroups', {
    configurable: true,
    value: { readRoots: async () => ({ ok: true, value: await readRoots() }) },
  });
  const { result } = renderHook(() => useThreadRoots({ ...params, database: null }));
  await waitFor(() => expect(result.current.primaryRemoved).toBe(true));
  expect(result.current.loadedSecondaryRoots).toEqual([
    { displayName: 'root', path: ROOT_PATH, removed: true, rootId: ROOT_ID },
  ]);
  await act(async () => {
    status = 'live';
    notifyRootRegistered([ROOT_ID, ROOT_PATH]);
  });
  await waitFor(() => expect(result.current.primaryRemoved).toBe(false));
  expect(result.current.loadedSecondaryRoots[0]?.removed).toBeUndefined();
});
