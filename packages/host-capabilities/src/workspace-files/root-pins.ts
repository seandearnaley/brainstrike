/**
 * ADR-0029 stage 4: the host's one open `SecureRoot` for each live workspace
 * root, shared by the Explorer's reads and root watches. A root is opened at its
 * first use and that handle and canonical path serve every later read and
 * watch, so renaming the folder and putting a symlink at its path never moves
 * the root somewhere else, the same pinning Main's mounted registry gave. The
 * handle closes once the catalog stops recording the root as live at that path
 * (seen at the next request) or when the host closes.
 */
import path from 'node:path';
import {
  BoundaryFailureError,
  fault,
  refusalError,
} from '@brainstrike/assistant-contract/boundary-failure';
import {
  createNativeSecureRoot,
  pathsEqual,
  type SecureWorkspaceRoot,
} from '@brainstrike/assistant-service/node-workspace-services';
import { createLogger } from '@brainstrike/logging';
import type { WorkspaceRootResolver } from '../workspace-root-cwd.ts';

const logger = createLogger('WorkspaceRootPins');

/** The refusal code of a live root whose folder is gone from disk. */
export const ROOT_UNMOUNTED = 'workspace.root-unmounted';

/** A root the host's catalog records as live, at its normalized absolute path. */
export interface LiveRoot {
  readonly path: string;
  readonly rootId: string;
}

/** The pinned handle of one live root, as it was when the host first opened it. */
export interface PinnedRoot {
  readonly canonicalPath: string;
  readonly presentationPath: string;
  readonly root: SecureWorkspaceRoot;
  readonly rootId: string;
}

export interface WorkspaceRootPins {
  /** Refuses new borrows, then closes every handle once its borrowers finish. */
  close(): Promise<void>;
  /** The live roots; a pin whose root is no longer live at its path is retired. */
  liveRoots(): Promise<LiveRoot[]>;
  /** Runs `use` on the root's pinned handle, opening it on first use. */
  use<T>(live: LiveRoot, use: (pinned: PinnedRoot) => Promise<T>): Promise<T>;
}

export interface WorkspaceRootPinOptions {
  /** Test seam; production opens the root with `SecureRoot`. */
  readonly openRoot?: (rootPath: string) => Promise<SecureWorkspaceRoot>;
  readonly roots: WorkspaceRootResolver;
}

interface Pin {
  borrowers: number;
  readonly closed: PromiseWithResolvers<void>;
  readonly opened: Promise<SecureWorkspaceRoot>;
  readonly path: string;
  retired: boolean;
  readonly rootId: string;
}

/** The folder's absence is the user's to fix; any other failure to open it is a fault. */
function openFailure(cause: unknown, rootId: string): Error {
  if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    logger.debug('A live workspace root is missing from disk', { rootId });
    return refusalError(
      'availability',
      ROOT_UNMOUNTED,
      'The workspace folder is not available.',
      'Reconnect the folder and retry.'
    );
  }
  logger.error('A live workspace root could not be opened', { cause, rootId });
  return new BoundaryFailureError(
    fault({
      category: 'internal',
      code: 'workspace.root-open-failed',
      message: 'The workspace folder could not be opened.',
    }),
    { cause }
  );
}

export function createWorkspaceRootPins(options: WorkspaceRootPinOptions): WorkspaceRootPins {
  const openRoot = options.openRoot ?? createNativeSecureRoot;
  const pins = new Map<string, Pin>();
  const retiring = new Set<Pin>();
  let closed = false;

  const closeIfIdle = (pin: Pin): void => {
    if (!(pin.retired && pin.borrowers === 0)) {
      return;
    }
    const settle = (): void => {
      retiring.delete(pin);
      pin.closed.resolve();
    };
    pin.opened.then((root) => {
      try {
        root.close();
      } catch (cause) {
        logger.error('A workspace root handle did not close', { cause, rootId: pin.rootId });
      } finally {
        settle();
      }
    }, settle);
  };

  const retire = (pin: Pin): void => {
    if (pin.retired) {
      return;
    }
    if (pins.get(pin.rootId) === pin) {
      pins.delete(pin.rootId);
    }
    pin.retired = true;
    retiring.add(pin);
    closeIfIdle(pin);
  };

  const pinFor = (live: LiveRoot): Pin => {
    const current = pins.get(live.rootId);
    if (current && pathsEqual(current.path, live.path)) {
      return current;
    }
    if (current) {
      retire(current);
    }
    const pin: Pin = {
      borrowers: 0,
      closed: Promise.withResolvers<void>(),
      opened: openRoot(live.path),
      path: live.path,
      retired: false,
      rootId: live.rootId,
    };
    // A folder that would not open is not pinned: the next use opens it afresh.
    pin.opened.catch(() => retire(pin));
    pins.set(live.rootId, pin);
    return pin;
  };

  return {
    close: async () => {
      closed = true;
      for (const pin of [...pins.values()]) {
        retire(pin);
      }
      await Promise.all([...retiring].map((pin) => pin.closed.promise));
    },
    liveRoots: async () => {
      const live = (await options.roots.listRoots())
        .filter((root) => path.isAbsolute(root.path))
        .map((root) => ({ path: path.normalize(root.path), rootId: root.rootId }));
      for (const pin of [...pins.values()]) {
        if (!live.some((root) => root.rootId === pin.rootId && pathsEqual(root.path, pin.path))) {
          retire(pin);
        }
      }
      return live;
    },
    use: async (live, use) => {
      if (closed) {
        throw refusalError(
          'availability',
          'workspace.files-closed',
          'Workspace files have stopped: the agent host is closing.'
        );
      }
      const pin = pinFor(live);
      pin.borrowers += 1;
      try {
        let root: SecureWorkspaceRoot;
        try {
          root = await pin.opened;
        } catch (cause) {
          throw openFailure(cause, live.rootId);
        }
        return await use({
          canonicalPath: path.normalize(root.canonicalPath),
          presentationPath: pin.path,
          root,
          rootId: pin.rootId,
        });
      } finally {
        pin.borrowers -= 1;
        closeIfIdle(pin);
      }
    },
  };
}
