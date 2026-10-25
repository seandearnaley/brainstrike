import type {
  FileSystemAdapter,
  GitInventory,
  GitResult,
  RootDescriptor,
} from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';
import { stubChangesBridge, workspaceGitWrapper } from './helpers/workspace-git-services-wrapper';

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
  const wrapper = workspaceGitWrapper({ changes: stubChangesBridge({ inventory }) });
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
  const { result, rerender } = renderHook(
    () =>
      useRootsReconciliation({ adapter, registration: { rootsRegistered: vi.fn(async () => {}) } }),
    { wrapper }
  );
  await act(async () => {
    expect(await result.current.resolveDbRootId(rootPath, rootId)).toBe(rootId);
  });
  expect(inventory).toHaveBeenCalledExactlyOnceWith({ maxAgeMs: 0 });
  rerender();
  expect(inventory).toHaveBeenCalledTimes(1);
});
