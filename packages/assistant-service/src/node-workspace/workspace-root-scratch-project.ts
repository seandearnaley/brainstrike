import path from 'node:path';
import {
  BoundaryFailureError,
  fault,
  refusalError,
} from '@brainstrike/assistant-contract/boundary-failure';
import { createLogger } from '@brainstrike/logging';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import { recordedRoot } from './workspace-root-catalog.ts';
import type {
  RecordedWorkspaceRoot,
  SecureWorkspaceRoot,
  StoredWorkspaceRoot,
} from './workspace-root-types.ts';

const logger = createLogger('WorkspaceRootScratchProject');

/** The registry's own mounts and records, lent to one scratch folder becoming a project. */
export interface ScratchProjectMounts {
  readonly catalog: () => Promise<WorkspaceRootPort>;
  readonly createSecureRoot: (rootPath: string) => Promise<SecureWorkspaceRoot>;
  /** Installs `probe` as the mount of `entry`, under its root id. */
  readonly install: (entry: StoredWorkspaceRoot, probe: SecureWorkspaceRoot) => Promise<unknown>;
  /** Whether the root is mounted now: a scratch folder mounts only once its thread needs it. */
  readonly isMounted: (rootId: string) => boolean;
  /** Mounts a recorded folder where its record says. */
  readonly mount: (entry: RecordedWorkspaceRoot) => Promise<unknown>;
  /** Records the folder in Recents and tells Main, as a folder the person adds is. */
  readonly recordRecent: (folder: string) => Promise<void>;
  /** Unmounts the root once its borrows end; its terminals and language servers go with it. */
  readonly retire: (rootId: string) => Promise<void>;
}

/** The folder a scratch folder became, as the host's scratch folders name it. */
export interface ScratchProjectRoot {
  readonly displayName: string;
  readonly path: string;
  readonly rootId: string;
}

/**
 * ADR-0034 build decisions: the thread's scratch folder becomes a folder of the person's. Its
 * mount retires first, so nothing works in it while it moves; `move` moves it and resolves where
 * it now is. A move that fails leaves the folder where it was, mounted there again if it was
 * mounted, and rethrows.
 * Then the folder is opened at its new place, whose canonical path is its identity, its record
 * turns (`scratch-to-project`: same root id, open, with a project), and it is mounted there and
 * joins Recents. A failure after the move says where the folder now is; nothing is mounted at a
 * place its record does not name.
 */
export async function turnScratchRootIntoProject(
  request: {
    readonly move: (folder: string) => Promise<string>;
    readonly threadId: string;
  },
  mounts: ScratchProjectMounts
): Promise<ScratchProjectRoot> {
  const catalog = await mounts.catalog();
  const [recorded] = (
    await catalog.workspaceRoots({ operation: 'scratch-of-thread', threadId: request.threadId })
  ).roots;
  if (!recorded) {
    throw refusalError(
      'input',
      'workspace.scratch-none',
      'This thread does not work in a scratch folder, so there is nothing to turn into a project.'
    );
  }
  // A folder not mounted yet (BST-2512) moves as it is, and a failed move leaves it so.
  const wasMounted = mounts.isMounted(recorded.id);
  await mounts.retire(recorded.id);
  let place: string;
  try {
    place = path.normalize(await request.move(recorded.path));
  } catch (cause) {
    try {
      if (wasMounted) {
        await mounts.mount(recordedRoot(recorded));
      }
    } catch (remount) {
      throw new AggregateError(
        [cause, remount],
        `The scratch folder was not moved, and could not be mounted again at ${recorded.path}`
      );
    }
    throw cause;
  }
  const displayName = path.basename(place) || place;
  let probe: SecureWorkspaceRoot | undefined;
  let turned = false;
  try {
    probe = await mounts.createSecureRoot(place);
    const [record] = (
      await catalog.workspaceRoots({
        operation: 'scratch-to-project',
        root: { canonicalPath: path.normalize(probe.canonicalPath), displayName, path: place },
        rootId: recorded.id,
      })
    ).roots;
    if (!record) {
      throw new Error('The roots domain answered no record');
    }
    turned = true;
    await mounts.install({ addedAt: record.createdAt, path: place, rootId: record.id }, probe);
    probe = undefined;
  } catch (cause) {
    probe?.close();
    throw afterMoveFailure(place, turned, cause);
  }
  await mounts.recordRecent(place);
  logger.info("Turned a thread's scratch folder into a project", {
    rootId: recorded.id,
    threadId: request.threadId,
  });
  return { displayName, path: place, rootId: recorded.id };
}

/** A failure once the folder has moved: it says where the folder is now, and what is left. */
function afterMoveFailure(place: string, turned: boolean, cause: unknown): BoundaryFailureError {
  return new BoundaryFailureError(
    fault(
      turned
        ? {
            category: 'internal',
            code: 'workspace.scratch-project-unmounted',
            message: `The scratch folder is now a project at ${place}, but it could not be opened there.`,
            remedy: 'It opens again at the next launch, or from Recents.',
          }
        : {
            category: 'internal',
            code: 'workspace.scratch-project-unrecorded',
            message: `The scratch folder was moved to ${place}, but it was not recorded as a project there.`,
            remedy: 'Add that folder to the workspace to work in it.',
          }
    ),
    { cause }
  );
}
