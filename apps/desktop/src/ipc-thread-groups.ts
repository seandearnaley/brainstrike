import type { WorkspaceRootPort } from '@brainstrike/state-store';
import type { ThreadGroupsPort } from '@brainstrike/types';
import { ipcMain } from 'electron';
import { threadGroupsContract } from './ipc-domains/thread-groups.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';
export function registerThreadGroupsIpc(store: ThreadGroupsPort & WorkspaceRootPort): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'threadGroups', threadGroupsContract, {
    readRoots: () =>
      settleIpcResult({ category: 'threadGroups', code: 'roots_read_failed' }, async () =>
        (await store.workspaceRoots({ operation: 'list' })).roots.map(
          ({ id, displayName, path, status }) => ({ displayName, id, path, status })
        )
      ),
    request: (request) =>
      settleIpcResult({ category: 'threadGroups', code: 'thread_groups_failed' }, () =>
        store.threadGroups(request)
      ),
  });
  return () => registry.unregisterAll();
}
