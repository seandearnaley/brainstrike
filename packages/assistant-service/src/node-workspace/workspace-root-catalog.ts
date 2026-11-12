import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import type { WorkspaceRootPort, WorkspaceRootRecord } from '@brainstrike/state-store';
import type { RecordedWorkspaceRoot } from './workspace-root-types.ts';
import { recordWorkspaceRootDisconnections } from './workspace-roots.ts';

const logger = createLogger('WorkspaceRootCatalog');

/** A catalog record as the registry reads it, with its grant-time identity. */
export function recordedRoot(root: {
  readonly canonicalPath: string;
  readonly createdAt: number;
  readonly id: string;
  readonly path: string;
}): RecordedWorkspaceRoot {
  return {
    addedAt: root.createdAt,
    canonicalPath: root.canonicalPath,
    path: root.path,
    rootId: root.id,
  };
}

export async function findRecordedWorkspaceRoot(
  catalog: WorkspaceRootPort,
  existing: RecordedWorkspaceRoot | undefined,
  match: (records: readonly RecordedWorkspaceRoot[]) => RecordedWorkspaceRoot | undefined
): Promise<RecordedWorkspaceRoot | undefined> {
  if (existing) {
    return existing;
  }
  const { roots } = await catalog.workspaceRoots({ operation: 'list' });
  return match(roots.map(recordedRoot));
}

/**
 * Records the folder under the identity its mount resolved. A recorded path that now resolves
 * elsewhere is refused unless the person granted it afresh (`repin`).
 */
export async function recordWorkspaceRoot(
  catalog: WorkspaceRootPort,
  root: { readonly canonicalPath: string; readonly path: string; readonly preferredId: string },
  repin = false
): Promise<{ readonly id: string; readonly kind: WorkspaceRootRecord['kind'] }> {
  const { roots } = await catalog.workspaceRoots({
    operation: 'register',
    ...(repin ? { repin } : {}),
    root: { ...root, displayName: path.basename(root.path) || root.path },
  });
  const recorded = roots[0];
  if (roots.length !== 1 || !recorded || recorded.path !== root.path) {
    throw new Error('Workspace registration returned a different identity');
  }
  return { id: recorded.id, kind: recorded.kind };
}

export async function markRootsDisconnectedExcept(
  catalog: WorkspaceRootPort,
  mountedPaths: readonly string[],
  closeRootIds: readonly string[] = []
): Promise<readonly { id: string; path: string }[]> {
  const { roots } = await catalog.workspaceRoots({
    closeRootIds,
    mountedPaths,
    operation: 'disconnect-except',
  });
  recordWorkspaceRootDisconnections(roots.map((root) => root.id));
  return roots;
}

/** Reopens the same granted records; no identity inference or conversion is allowed. */
export async function recordRestoredWorkspaceRoots(
  getCatalog: () => Promise<WorkspaceRootPort>,
  roots: readonly RecordedWorkspaceRoot[]
): Promise<void> {
  if (roots.length === 0) {
    return;
  }
  try {
    const catalog = await getCatalog();
    for (const root of roots) {
      const { id: recordedId } = await recordWorkspaceRoot(catalog, {
        canonicalPath: root.canonicalPath,
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
