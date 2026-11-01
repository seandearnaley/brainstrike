/**
 * ADR-0029 stage 4: the Explorer's reads and root watches borrow the host's one
 * open `SecureRoot` for each workspace folder: the handle its root registry
 * opened when the folder was granted (or restored). That handle and its
 * canonical path serve every read and watch, so renaming the folder and putting
 * a symlink at its path never moves the root somewhere else. The registry is
 * the handles' one owner: it closes a folder's handle once the folder leaves,
 * after the borrows on it settle, and a folder whose data is being deleted is
 * absent here for the whole deletion.
 */
import path from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import {
  type MountedWorkspaceRoot,
  pathsEqual,
  type SecureWorkspaceRoot,
} from '@brainstrike/assistant-service/node-workspace-services';

/** The refusal code of a root that is not mounted: its folder is gone or not reconnected. */
export const ROOT_UNMOUNTED = 'workspace.root-unmounted';

/** A root the host's registry has mounted, at its normalized absolute path. */
export interface LiveRoot {
  readonly path: string;
  readonly rootId: string;
}

/** The pinned handle of one live root, as the registry opened it at grant. */
export interface PinnedRoot {
  readonly canonicalPath: string;
  readonly presentationPath: string;
  readonly root: SecureWorkspaceRoot;
  readonly rootId: string;
}

export interface WorkspaceRootPins {
  /** Refuses new borrows, then waits for the borrows in flight. */
  close(): Promise<void>;
  /** The mounted roots. */
  liveRoots(): Promise<LiveRoot[]>;
  /** Runs `use` on the root's pinned handle. */
  use<T>(live: LiveRoot, use: (pinned: PinnedRoot) => Promise<T>): Promise<T>;
}

/** The host root registry's mounts: the one owner of each folder's handle. */
export interface WorkspaceRootMounts {
  mountedRoots(): readonly { canonicalPath: string; path: string; rootId: string }[];
  useMountedRoot<T>(rootId: string, use: (mounted: MountedWorkspaceRoot) => Promise<T>): Promise<T>;
}

export interface WorkspaceRootPinOptions {
  readonly mounts: WorkspaceRootMounts;
}

const unmounted = () =>
  refusalError(
    'availability',
    ROOT_UNMOUNTED,
    'The workspace folder is not available.',
    'Reconnect the folder and retry.'
  );

export function createWorkspaceRootPins(options: WorkspaceRootPinOptions): WorkspaceRootPins {
  const { mounts } = options;
  const inFlight = new Set<Promise<unknown>>();
  let closed = false;

  return {
    close: async () => {
      closed = true;
      await Promise.allSettled([...inFlight]);
    },
    liveRoots: async () =>
      mounts
        .mountedRoots()
        .filter((root) => path.isAbsolute(root.path))
        .map((root) => ({ path: path.normalize(root.path), rootId: root.rootId })),
    use: async (live, use) => {
      if (closed) {
        throw refusalError(
          'availability',
          'workspace.files-closed',
          'Workspace files have stopped: the agent host is closing.'
        );
      }
      let entered = false;
      const pending = mounts
        .useMountedRoot(live.rootId, async (mounted) => {
          entered = true;
          // The folder was replaced at another path since the caller listed it.
          if (!pathsEqual(mounted.presentationPath, live.path)) {
            throw unmounted();
          }
          return await use({
            canonicalPath: path.normalize(mounted.canonicalPath),
            presentationPath: path.normalize(mounted.presentationPath),
            root: mounted.root,
            rootId: mounted.rootId,
          });
        })
        .catch((cause: unknown) => {
          // The registry refused the borrow: the folder left between the listing and the use.
          throw entered ? cause : unmounted();
        });
      inFlight.add(pending);
      try {
        return await pending;
      } finally {
        inFlight.delete(pending);
      }
    },
  };
}
