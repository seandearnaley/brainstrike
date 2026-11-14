import {
  BoundaryFailureError,
  fault,
  refusalError,
} from '@brainstrike/assistant-contract/boundary-failure';
import type { WorkspaceRootPort, WorkspaceRootRecord } from '@brainstrike/state-store';
import { isFileNotFoundError } from './file-not-found-error.ts';
import { recordedRoot, recordWorkspaceRoot } from './workspace-root-catalog.ts';
import type { RecordedWorkspaceRoot } from './workspace-root-types.ts';

/** The registry's own mounts and records, lent to mount scratch folders on demand. */
export interface ScratchRootMounts {
  readonly catalog: WorkspaceRootPort;
  readonly isMounted: (rootId: string) => boolean;
  /** Mounts a recorded folder where its record says, under the identity it was granted with. */
  readonly mount: (entry: RecordedWorkspaceRoot) => Promise<unknown>;
}

/** Why a scratch folder its thread needs could not be mounted, naming the folder and its place. */
function scratchMountFailure(record: WorkspaceRootRecord, cause: unknown): BoundaryFailureError {
  if (isFileNotFoundError(cause)) {
    return refusalError(
      'availability',
      'workspace.root-missing',
      `The scratch folder ${record.displayName} is no longer at ${record.path}.`,
      'It was moved or deleted outside Brainstrike. Put it back there, or delete this thread.'
    );
  }
  return new BoundaryFailureError(
    fault({
      category: 'internal',
      code: 'workspace.scratch-unmounted',
      message: `The scratch folder ${record.displayName} at ${record.path} could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`,
    }),
    { cause }
  );
}

/**
 * ADR-0034 (BST-2512): a scratch folder mounts the first time its thread needs it, never at
 * launch. Mounts the recorded scratch folder, unless it is mounted, and marks its record live,
 * which says it is mounted now. A folder that cannot be mounted is refused by name and place.
 */
export async function mountScratchRoot(
  record: WorkspaceRootRecord,
  mounts: ScratchRootMounts
): Promise<void> {
  if (!mounts.isMounted(record.id)) {
    try {
      await mounts.mount(recordedRoot(record));
    } catch (cause) {
      throw scratchMountFailure(record, cause);
    }
  }
  if (record.status !== 'live') {
    await recordWorkspaceRoot(mounts.catalog, {
      canonicalPath: record.canonicalPath,
      path: record.path,
      preferredId: record.id,
    });
  }
}

/** Deletes the record of a scratch folder just made that was not mounted, then rethrows why. */
export async function forgetUnmountedScratch(
  catalog: WorkspaceRootPort,
  threadId: string,
  cause: unknown
): Promise<never> {
  try {
    await catalog.workspaceRoots({ operation: 'forget-scratch', threadId });
  } catch (cleanup) {
    throw new AggregateError(
      [cause, cleanup],
      'The scratch folder was not mounted, and its record could not be deleted'
    );
  }
  throw cause;
}

/**
 * The scratch folders among `rootIds`, as a run's binding names them, each mounted as
 * `mountScratchRoot` mounts one.
 */
export async function mountScratchRoots(
  rootIds: readonly string[],
  mounts: ScratchRootMounts
): Promise<void> {
  const { roots } = await mounts.catalog.workspaceRoots({ operation: 'list-scratch' });
  for (const record of roots.filter((root) => rootIds.includes(root.id))) {
    // eslint-disable-next-line react-doctor/async-await-in-loop -- one change at a time, as the registry makes every change.
    await mountScratchRoot(record, mounts);
  }
}
