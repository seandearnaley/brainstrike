import { UserCancelledError } from '@brainstrike/file-system';
import { descriptorFor } from '@brainstrike/file-system/workspace-root-nodes';
import type { RecentRootEntry, RootDescriptor } from '@brainstrike/types';
import { type DesktopHostConnection, windowHostConnection } from './desktop-host-connection';

/** The desktop workspace's open folders, as the file-system adapter exposes them. */
export interface DesktopWorkspaceRoots {
  addRootByPath(path: string): Promise<RootDescriptor>;
  listRecentRoots(): Promise<readonly RecentRootEntry[]>;
  /**
   * Opens a folder as the window's project, closing the other open folders (ADR-0034): a recent
   * folder by path, else through the picker. Rejects with `UserCancelledError` when the person
   * cancels the picker.
   */
  openRoot(path?: string): Promise<RootDescriptor>;
  /** Rejects with `UserCancelledError` when the person cancels the picker. */
  pickRoot(): Promise<RootDescriptor>;
  removeRoot(rootId: string): Promise<void>;
  restoreRoots(): Promise<RootDescriptor[]>;
}

/** One mounted folder as `workspace/roots/*` answers it. */
interface HostOpenRoot {
  readonly available: boolean;
  readonly path: string;
  readonly rootId: string;
  /** A managed worktree: a thread's checkout, never one of the open folders (ADR-0034). */
  readonly worktree: boolean;
}

function descriptor(root: HostOpenRoot): RootDescriptor {
  const described = descriptorFor(
    { addedAt: 0, path: root.path, rootId: root.rootId },
    root.available ? 'granted' : 'unknown'
  );
  return root.worktree
    ? { ...described, handle: { ...described.handle, worktree: true } }
    : described;
}

/**
 * ADR-0029 stage 4: the agent host's root registry owns the open folders and the
 * recent-folders ledger; Main keeps only the native picker, which the host asks for.
 */
export function createDesktopWorkspaceRoots(
  connection: DesktopHostConnection
): DesktopWorkspaceRoots {
  return {
    addRootByPath: async (path) =>
      descriptor(await (await connection.current()).request('workspace/roots/add', { path })),
    listRecentRoots: async () =>
      (await (await connection.current()).request('workspace/roots/recent', {})).roots,
    openRoot: async (path) => {
      const { root } = await (await connection.current()).request(
        'workspace/roots/open',
        path === undefined ? {} : { path }
      );
      if (root === null) {
        throw new UserCancelledError();
      }
      return descriptor(root);
    },
    pickRoot: async () => {
      const { root } = await (await connection.current()).request('workspace/roots/pick', {});
      if (root === null) {
        throw new UserCancelledError();
      }
      return descriptor(root);
    },
    removeRoot: async (rootId) => {
      await (await connection.current()).request('workspace/roots/remove', { rootId });
    },
    restoreRoots: async () =>
      (await (await connection.current()).request('workspace/roots/restore', {})).roots.map(
        descriptor
      ),
  };
}

let windowRoots: DesktopWorkspaceRoots | undefined;

/** `null` where this window has no agent-host capability. */
export function resolveDesktopWorkspaceRoots(): DesktopWorkspaceRoots | null {
  if (!window.agentHost) {
    return null;
  }
  windowRoots ??= createDesktopWorkspaceRoots(windowHostConnection());
  return windowRoots;
}
