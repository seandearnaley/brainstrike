import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import type { StoredWorkspaceRoot } from './workspace-root-types.js';
import { recordWorkspaceRootDisconnections } from './workspace-roots.js';

const logger = createLogger('WorkspaceRootCatalog');

export async function findRecordedWorkspaceRoot(
  catalog: WorkspaceRootPort,
  existing: StoredWorkspaceRoot | undefined,
  match: (records: readonly StoredWorkspaceRoot[]) => Promise<StoredWorkspaceRoot | undefined>
): Promise<StoredWorkspaceRoot | undefined> {
  if (existing) {
    return existing;
  }
  const { roots } = await catalog.workspaceRoots({ operation: 'list' });
  return await match(
    roots.map((root) => ({ addedAt: root.createdAt, path: root.path, rootId: root.id }))
  );
}

export async function recordWorkspaceRoot(
  catalog: WorkspaceRootPort,
  root: { readonly path: string; readonly preferredId: string }
): Promise<string> {
  const { roots } = await catalog.workspaceRoots({
    operation: 'register',
    root: { ...root, displayName: path.basename(root.path) || root.path },
  });
  const recorded = roots[0];
  if (roots.length !== 1 || !recorded || recorded.path !== root.path) {
    throw new Error('Workspace registration returned a different identity');
  }
  return recorded.id;
}

export async function markRootsDisconnectedExcept(
  catalog: WorkspaceRootPort,
  mountedPaths: readonly string[]
): Promise<readonly { id: string; path: string }[]> {
  const { roots } = await catalog.workspaceRoots({ mountedPaths, operation: 'disconnect-except' });
  recordWorkspaceRootDisconnections(roots.map((root) => root.id));
  return roots;
}

/** Reopens the same granted records; no identity inference or conversion is allowed. */
export async function recordRestoredWorkspaceRoots(
  getCatalog: () => Promise<WorkspaceRootPort>,
  roots: readonly { readonly path: string; readonly rootId: string }[]
): Promise<void> {
  if (roots.length === 0) {
    return;
  }
  try {
    const catalog = await getCatalog();
    for (const root of roots) {
      const recordedId = await recordWorkspaceRoot(catalog, {
        path: root.path,
        preferredId: root.rootId,
      });
      if (recordedId !== root.rootId) {
        logger.error(
          'A restored workspace folder is mounted under a different id than its record',
          { recordedId, rootId: root.rootId }
        );
      }
    }
  } catch (error) {
    logger.error('Restored workspace folders could not be recorded', { error });
  }
}
