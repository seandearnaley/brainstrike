/**
 * ADR-0029 stage 4: the desktop workspace's open folders, owned by the agent
 * host. Its root registry is the one writer of the root records (and their
 * open order) and of the recent-folders ledger, through the host's own store.
 * Main keeps only the folder picker, which this asks for.
 */
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { HostOpenRoot, HostRootRegistry } from '@brainstrike/agent-host';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import {
  type ManagedWorktreeAuthorizer,
  type SecureWorkspaceRoot,
  WorkspaceRootRegistry,
  type WorkspaceRootStorage,
} from '@brainstrike/assistant-service/node-workspace-services';
import { createLogger } from '@brainstrike/logging';
import type { StateStore } from '@brainstrike/state-store';
import type { RootDescriptor } from '@brainstrike/types';
import { createWorkspaceRootResolver, type WorkspaceRootResolver } from '../workspace-root-cwd.ts';

const logger = createLogger('HostRootRegistry');

/** The host store's roots domain and settings, where the recent-folders ledger lives. */
export type HostRootRegistryStore = Pick<
  StateStore,
  'deleteSetting' | 'getSetting' | 'setSetting' | 'workspaceRoots'
>;

export interface HostRootRegistryOptions {
  /** Test seam; production opens each folder with `SecureRoot`. */
  readonly createSecureRoot?: (rootPath: string) => Promise<SecureWorkspaceRoot>;
  readonly disposeCommandSessionsForRoot: (rootId: string) => Promise<number>;
  /** Whether `workspace/roots/seed-for-e2e` may run: only in a desktop E2E session. */
  readonly e2e: boolean;
  readonly evictLspServersForRoot: (rootId: string) => Promise<void>;
  /** The worktree ledger says whether a path is a managed worktree, which mounts without the picker. */
  readonly managedWorktreeAuthorizer: ManagedWorktreeAuthorizer;
  /** Main's native folder picker: the chosen folder, or null when the person cancelled. */
  readonly pickFolder: () => Promise<string | null>;
  /**
   * Tells Main the open folders changed: its native index re-reads the live roots (it learns of a
   * removal after the host disconnected the folder, D1), and its OS recent documents and File
   * menu follow the recent-folders ledger.
   */
  readonly publishRootsChanged: (change: {
    readonly grantedPath?: string;
    readonly recentPaths: readonly string[];
  }) => Promise<void>;
  readonly store: HostRootRegistryStore;
}

export interface HostRootRegistryOwner {
  /** Disposes every mount after the registry's mutations settle. */
  close(): Promise<void>;
  /** Refuses new mutations and joins the admitted ones while the store is still open. */
  prepareClose(): Promise<void>;
  readonly registry: WorkspaceRootRegistry;
  /**
   * The live folders every host capability resolves against (reads, watches, terminals, git).
   * A folder whose data is being deleted is absent for the whole deletion, not only once it
   * disconnects, so nothing new reaches it while its records go.
   */
  readonly roots: WorkspaceRootResolver;
  readonly service: HostRootRegistry;
  /** Mounts the open folders, so the catalog's live roots are true before any client reads them. */
  start(): Promise<void>;
}

/** The ledger's settings live beside the host's other settings, under one prefix. */
const SETTING_PREFIX = 'workspace.';
const RECENT_ROOTS_KEY = 'recentRootsList';

function wireRoot(descriptor: RootDescriptor): HostOpenRoot {
  return {
    available: descriptor.permissionState === 'granted',
    path: descriptor.handle.path,
    rootId: descriptor.rootId,
  };
}

async function pathExists(rootPath: string): Promise<boolean> {
  try {
    await access(rootPath);
    return true;
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      return false;
    }
    throw cause;
  }
}

function directoryHandle(folder: string) {
  return {
    kind: 'directory' as const,
    name: path.basename(folder) || folder,
    path: folder,
    platform: 'electron' as const,
  };
}

export function createHostRootRegistry(options: HostRootRegistryOptions): HostRootRegistryOwner {
  const { store } = options;
  const recents: WorkspaceRootStorage = {
    getItem: async (key) => (await store.getSetting(`${SETTING_PREFIX}${key}`)) ?? null,
    removeItem: async (key) => {
      await store.deleteSetting(`${SETTING_PREFIX}${key}`);
    },
    setItem: (key, value) => store.setSetting(`${SETTING_PREFIX}${key}`, value),
  };
  // The folder the last mutation granted, for Main's OS recent documents.
  let grantedPath: string | undefined;
  /**
   * After a mutation commits: Main missing the news is logged, never the mutation's failure, and
   * Main's next re-read (any later change, or a restart) still converges.
   */
  const publish = async (): Promise<void> => {
    const granted = grantedPath;
    grantedPath = undefined;
    try {
      const recentPaths = (await registry.listRecentRoots()).map((entry) => entry.path);
      await options.publishRootsChanged({
        ...(granted ? { grantedPath: granted } : {}),
        recentPaths,
      });
    } catch (cause) {
      logger.warn('Main did not learn that the open folders changed', { cause });
    }
  };
  const registry: WorkspaceRootRegistry = new WorkspaceRootRegistry({
    ...(options.createSecureRoot ? { createSecureRoot: options.createSecureRoot } : {}),
    disposeCommandSessionsForRoot: options.disposeCommandSessionsForRoot,
    evictLspServersForRoot: options.evictLspServersForRoot,
    getRootsCatalog: async () => store,
    onRootGranted: (granted) => {
      grantedPath = granted;
    },
    pathExists,
    recents,
  });
  registry.setManagedWorktreeAuthorizer(options.managedWorktreeAuthorizer);
  const catalogRoots = createWorkspaceRootResolver(store);
  const roots: WorkspaceRootResolver = {
    listRoots: async () =>
      (await catalogRoots.listRoots()).filter((root) => !registry.isDeletingRootData(root.rootId)),
  };

  const service: HostRootRegistry = {
    'workspace/roots/add': async ({ path: folder }) => {
      const added = await registry.addRootByPath(folder);
      await publish();
      return wireRoot(added);
    },
    // Main's native index asks for this with its sources stopped, and re-reads the roots as it
    // resumes, so this sends Main no change. From the reservation to its release the folder is
    // fenced: `roots` omits it (reads, watches, terminals, git) and run borrows are refused.
    'workspace/roots/delete-data': async ({ rootId }) => {
      const reservation = registry.reserveRootDataDeletion(rootId);
      try {
        await reservation.run(async () => {
          await reservation.retireSources();
          const { mounted } = reservation;
          await store.workspaceRoots({
            operation: 'delete',
            paths: [mounted.canonicalPath, mounted.presentationPath],
            rootId,
          });
          await reservation.disconnect();
        });
      } finally {
        reservation.release();
      }
      return null;
    },
    'workspace/roots/mounted': async () => ({ roots: registry.mountedRoots() }),
    'workspace/roots/pick': async () => {
      const folder = await options.pickFolder();
      if (folder === null) {
        return { root: null };
      }
      const added = await registry.addRoot(directoryHandle(folder));
      await publish();
      return { root: wireRoot(added) };
    },
    'workspace/roots/recent': async () => ({ roots: await registry.listRecentRoots() }),
    'workspace/roots/remove': async ({ rootId }) => {
      await registry.removeRoot(rootId);
      await publish();
      return null;
    },
    'workspace/roots/restore': async () => {
      const restored = await registry.restoreRoots();
      await publish();
      return { roots: restored.map(wireRoot) };
    },
    'workspace/roots/seed-for-e2e': async ({ recentPaths, roots }) => {
      if (!options.e2e) {
        throw refusalError(
          'authorization',
          'workspace.e2e-only',
          'Seeding workspace folders is available only in a desktop E2E session'
        );
      }
      const { roots: open } = await store.workspaceRoots({ operation: 'list-open' });
      await store.workspaceRoots({
        closeRootIds: open.map((root) => root.id),
        mountedPaths: [],
        operation: 'disconnect-except',
      });
      for (const root of roots) {
        const { roots: recorded } = await store.workspaceRoots({
          operation: 'register',
          // The seeded folder is pinned as a grant pins it: to the folder its path resolves to.
          root: {
            canonicalPath: await realpath(root.path),
            displayName: path.basename(root.path) || root.path,
            path: root.path,
            preferredId: root.rootId,
          },
        });
        if (recorded[0]?.id !== root.rootId) {
          throw new Error(`The seeded folder ${root.path} already has another id`);
        }
      }
      await recents.setItem(
        RECENT_ROOTS_KEY,
        JSON.stringify(recentPaths.map((recentPath) => ({ lastGrantedAt: 1, path: recentPath })))
      );
      // The mounts follow the seeded records, as a restart would restore them.
      await registry.restoreRoots();
      await publish();
      return null;
    },
  };

  return {
    close: () => registry.dispose(),
    prepareClose: () => registry.prepareClose(),
    registry,
    roots,
    service,
    start: async () => {
      await registry.restoreRoots();
      await publish();
    },
  };
}
