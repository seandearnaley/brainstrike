import type { DbHandle } from '@brainstrike/db/react';
import type {
  FileSystemAdapter,
  GitInventory,
  GitResult,
  RootDescriptor,
} from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CHANGES_BRIDGE_REQUIRED_METHODS, type ChangesBridge } from '../changes/changes-bridge';
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';

it('discovers roots recorded by the host during restore after the eager inventory read', async () => {
  // BST-1990: the real folders-panel E2E lost its branch badges because
  // Main restores records after its eager inventory build, while the
  // renderer only maps those records and reports no inserts.
  const rootPath = '/workspace/docs';
  const rootId = 'host-root';
  const inventory = vi.fn(
    async (): Promise<GitResult<GitInventory>> => ({
      ok: true,
      value: { errors: [], repositories: [] },
    })
  );
  const bridge: Record<string, unknown> = {};
  for (const method of CHANGES_BRIDGE_REQUIRED_METHODS) {
    bridge[method] = method === 'inventory' ? inventory : vi.fn();
  }
  const previous = window.changes;
  window.changes = bridge as Partial<ChangesBridge>;
  const query = vi.fn(async () => ({
    rows: [{ id: rootId, kind: 'path', path: rootPath, status: 'live' }],
  }));
  const db = { query } as unknown as DbHandle;
  const root: RootDescriptor = {
    displayName: 'docs',
    handle: { kind: 'directory', name: 'docs', path: rootPath, platform: 'electron' },
    kind: 'path',
    permissionState: 'granted',
    persisted: true,
    rootId,
  };
  const adapter = {
    ownsRootRecords: true,
    platform: 'electron',
    restoreRoots: async () => [root],
  } as FileSystemAdapter;
  try {
    const { result, rerender } = renderHook(() => useRootsReconciliation({ adapter, db }));
    await act(async () => {
      expect(await result.current.resolveDbRootId(rootPath, rootId)).toBe(rootId);
    });
    expect(inventory).toHaveBeenCalledExactlyOnceWith({ maxAgeMs: 0 });
    rerender();
    expect(inventory).toHaveBeenCalledTimes(1);
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(window, 'changes');
    } else {
      window.changes = previous;
    }
  }
});
