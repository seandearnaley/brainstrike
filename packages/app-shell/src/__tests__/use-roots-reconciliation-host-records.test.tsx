import type { FileSystemAdapter, RootDescriptor } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  awaitRootRegistration,
  resetRootRegistrationEventsForTests,
  rootRegistrationSeq,
} from '../roots/root-registration-events';
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';

/**
 * BST-1990: on desktop, Main's root registry records every folder in `roots`
 * under its one id, so a folder removed and re-added comes back with the same
 * id. The hook must forget a folder that is no longer mounted, or the re-add
 * would be skipped as a repeat registration and never wake its waiters or the
 * native index.
 */

function desktopRoot(rootId: string, name: string, path: string): RootDescriptor {
  return {
    displayName: name,
    handle: { kind: 'directory', name, path, platform: 'electron' },
    kind: 'path',
    permissionState: 'granted',
    persisted: true,
    rootId,
  };
}

beforeEach(() => {
  resetRootRegistrationEventsForTests();
});

it('registers a folder re-added under its one id again after it was removed', async () => {
  const descriptor = desktopRoot('one-id', 'docs', '/workspace/docs');
  const adapter = {
    ownsRootRecords: true,
    platform: 'electron',
    restoreRoots: vi.fn(async (): Promise<RootDescriptor[]> => [descriptor]),
  } as unknown as FileSystemAdapter;
  const query = vi.fn(async (sql: string) =>
    sql.includes('SELECT') ? { rows: [{ id: 'one-id', path: '/workspace/docs' }] } : { rows: [] }
  );
  const { result } = renderHook(() => useRootsReconciliation({ adapter, db: null }));
  await waitFor(() => expect(result.current.rootsReconciliationSettled).toBe(true));

  expect([...result.current.dbRootIdByAdapterRootId]).toEqual([['one-id', 'one-id']]);
  // Removed: the mounted set no longer has it, so the hook forgets it, including
  // in the published map Explorer search scopes its query by.
  await act(async () => {
    await result.current.syncMountedRoots([]);
  });
  expect([...result.current.dbRootIdByAdapterRootId]).toEqual([]);
  expect([...result.current.dbRootKindByAdapterRootId]).toEqual([]);
  // Re-added under the same id: a new registration wakes waiters again.
  const waiter = awaitRootRegistration('/workspace/docs', {
    since: rootRegistrationSeq('/workspace/docs'),
    timeoutMs: 1000,
  });
  await act(async () => {
    await result.current.syncMountedRoots([descriptor]);
  });
  await expect(waiter).resolves.toBeUndefined();
  expect([...result.current.dbRootIdByAdapterRootId]).toEqual([['one-id', 'one-id']]);
  await expect(result.current.resolveDbRootId('/workspace/docs', 'one-id')).resolves.toBe('one-id');
  // The host owns the record: the hook only ever read it.
  expect(query).not.toHaveBeenCalled();
});
