import type { WorkspaceRootPort } from '@brainstrike/state-store';
import type { ThreadGroupsPort } from '@brainstrike/types';
import { ThreadGroupsRequestSchema } from '@brainstrike/types/catalog-args';
import { Schema } from 'effect';
import { ipcMain } from 'electron';
import { threadGroupsContract } from './ipc-domains/thread-groups.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';
import { NoArgs } from './platform/ipc-args';
export function registerThreadGroupsIpc(store: ThreadGroupsPort & WorkspaceRootPort): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(
    registry,
    'threadGroups',
    threadGroupsContract,
    { readRoots: NoArgs, request: Schema.Tuple([ThreadGroupsRequestSchema]) },
    {
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
    }
  );
  return () => registry.unregisterAll();
}
