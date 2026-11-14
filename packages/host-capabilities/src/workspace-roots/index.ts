/**
 * ADR-0029 stage 4: the desktop workspace's open folders, owned by the agent
 * host. Its root registry is the one writer of the root records (and their
 * open order) and of the recent-folders ledger, through the host's own store.
 * Main keeps only the folder picker, which this asks for.
 */
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  HostOpenRoot,
  HostRootRegistry,
  HostScratchFolderRoots,
  HostThreadReads,
} from '@brainstrike/agent-host';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import {
  locateUnknownRefusal,
  type ManagedWorktreeAuthorizer,
  type SecureWorkspaceRoot,
  WorkspaceRootRegistry,
  type WorkspaceRootStorage,
} from '@brainstrike/assistant-service/node-workspace-services';
import { createLogger } from '@brainstrike/logging';
import { type StateStore, StateStoreReadOnlyError } from '@brainstrike/state-store';
import type { RootDescriptor } from '@brainstrike/types';
import { runningRunRootIds } from '../git-workspace/worktree-host-activity.ts';
import { removeProjectMemory } from '../project-memory/memory-notes.ts';
import { createWorkspaceRootResolver, type WorkspaceRootResolver } from '../workspace-root-cwd.ts';

const logger = createLogger('HostRootRegistry');

/**
 * The host store's roots domain and settings, where the recent-folders ledger lives, and the
 * damage it opened with: a damaged store is read-only.
 */
export type HostRootRegistryStore = Pick<
  StateStore,
  'deleteSetting' | 'getSetting' | 'root' | 'setSetting' | 'stateDamage' | 'workspaceRoots'
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
   * Tells Main the open folders changed: its OS recent documents and File menu follow the
   * recent-folders ledger.
   */
  readonly publishRootsChanged: (change: {
    readonly grantedPath?: string;
    readonly recentPaths: readonly string[];
  }) => Promise<void>;
  readonly store: HostRootRegistryStore;
}

export interface HostRootRegistryOwner {
  /** Core's thread reads: an open keeps the folders a running run works in mounted. */
  attachThreadReads(reads: HostThreadReads): void;
  /** Disposes every mount after the registry's mutations settle. */
  close(): Promise<void>;
  /** Refuses new mutations and joins the admitted ones while the store is still open. */
  prepareClose(): Promise<void>;
  readonly registry: WorkspaceRootRegistry;
  /** The live folders every host capability resolves against (reads, watches, terminals, git). */
  readonly roots: WorkspaceRootResolver;
  /** ADR-0034 scratch threads: the roots of the folders the host makes for threads. */
  readonly scratch: HostScratchFolderRoots;
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
    scratch: descriptor.handle.scratch === true,
    worktree: descriptor.handle.worktree === true,
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

/** Whether a recorded folder is still where its record says: its path leads to its identity. */
async function stillRecordedPlace(record: {
  readonly canonicalPath: string;
  readonly path: string;
}): Promise<boolean> {
  try {
    return (await realpath(record.path)) === record.canonicalPath;
  } catch (cause) {
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
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
  // BST-2144: a damaged store opened read-only. The registry still serves the open folders, and
  // refuses every change with the store's own refusal, which crosses as a typed refusal.
  const readOnlyRefusal = (): Error | null =>
    store.stateDamage === null ? null : new StateStoreReadOnlyError(store.stateDamage);
  const refuseWhenReadOnly = (): void => {
    const refused = readOnlyRefusal();
    if (refused) {
      throw refused;
    }
  };
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
    readOnlyRefusal,
    recents,
  });
  registry.setManagedWorktreeAuthorizer(options.managedWorktreeAuthorizer);
  const roots = createWorkspaceRootResolver(store);
  let threadReads: HostThreadReads | undefined;
  /** The folders running runs were admitted with: an open closes them but keeps them mounted. */
  const runningRoots = (): Promise<Set<string>> => {
    const reads = threadReads;
    if (!reads) {
      throw new Error('The agent host has not opened its threads yet');
    }
    return runningRunRootIds({
      readLedger: () => reads.readLedger(),
      readThread: (threadId) => reads.read(threadId, 0),
    });
  };

  const service: HostRootRegistry = {
    // ADR-0034: a project's name and folders are written by the store's roots domain, whose
    // refusals (a name too long, an unknown project or folder, a thread's own folder) are typed.
    'projects/join': async (request) => {
      refuseWhenReadOnly();
      const { deletedProjectIds = [] } = await store.workspaceRoots(
        'rootId' in request
          ? { operation: 'join-project', projectId: request.projectId, rootId: request.rootId }
          : {
              // The listing names a repository found inside an open folder by its canonical path.
              canonicalPath: request.repositoryPath,
              operation: 'join-project',
              projectId: request.projectId,
            }
      );
      // ADR-0040: a project the join emptied and deleted takes its memory with it.
      await Promise.all(
        deletedProjectIds.map((projectId) => removeProjectMemory(store.root, projectId))
      );
      return null;
    },
    'projects/rename': async (request) => {
      refuseWhenReadOnly();
      await store.workspaceRoots(
        'projectId' in request
          ? { name: request.name, operation: 'rename-project', projectId: request.projectId }
          : {
              // A repository's first name makes its project (BST-2520).
              canonicalPath: request.repositoryPath,
              name: request.name,
              operation: 'rename-project',
            }
      );
      return null;
    },
    'workspace/roots/add': async ({ path: folder }) => {
      const added = await registry.addRootByPath(folder);
      await publish();
      return wireRoot(added);
    },
    // ADR-0034 relink. A read-only store, a thread's own folder and a folder still at its place
    // refuse before the person chooses one.
    'workspace/roots/locate': async ({ rootId }) => {
      refuseWhenReadOnly();
      const { roots: recorded } = await store.workspaceRoots({ operation: 'list' });
      const record = recorded.find((root) => root.id === rootId);
      if (record?.kind !== 'path') {
        throw locateUnknownRefusal();
      }
      if (await stillRecordedPlace(record)) {
        throw refusalError(
          'conflict',
          'workspace.locate-present',
          `The folder is still at ${record.path}, so there is nothing to locate.`,
          'Open it from Recents.'
        );
      }
      const picked = await options.pickFolder();
      if (picked === null) {
        return { root: null };
      }
      const located = await registry.locateRoot(rootId, directoryHandle(picked));
      await publish();
      return { root: wireRoot(located) };
    },
    'workspace/roots/open': async ({ path: folder }) => {
      let opened: RootDescriptor;
      if (folder === undefined) {
        // A read-only store refuses before the person chooses a folder it could not open.
        const refused = readOnlyRefusal();
        if (refused) {
          throw refused;
        }
        const picked = await options.pickFolder();
        if (picked === null) {
          return { root: null };
        }
        opened = await registry.openRoot(directoryHandle(picked), await runningRoots());
      } else {
        opened = await registry.openRootByPath(folder, await runningRoots());
      }
      await publish();
      return { root: wireRoot(opened) };
    },
    'workspace/roots/pick': async () => {
      // A read-only store refuses before the person chooses a folder it could not open.
      const refused = readOnlyRefusal();
      if (refused) {
        throw refused;
      }
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
    // The host restored the open folders at its start, so a window opening reads them: nothing is
    // written and Main is not told. Only a folder that is not mounted (it was unavailable, or
    // changed outside this host) restores them again.
    'workspace/roots/restore': async () => {
      const current = await registry.currentRoots();
      if (current) {
        return { roots: current.map(wireRoot) };
      }
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
      const refused = readOnlyRefusal();
      if (refused) {
        throw refused;
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
    attachThreadReads: (reads) => {
      threadReads = reads;
    },
    close: () => registry.dispose(),
    prepareClose: () => registry.prepareClose(),
    registry,
    roots,
    scratch: {
      add: (request) => registry.addScratchRoot(request),
      forget: (threadId) => registry.forgetScratchRoot(threadId),
      // ADR-0034: a folder of the person's now, open and in Recents, so Main hears of it.
      promote: async (request) => {
        const promoted = await registry.turnScratchIntoProject(request);
        await publish();
        return promoted;
      },
      read: (threadId) => registry.readScratchRoot(threadId),
    },
    service,
    start: async () => {
      await registry.restoreRoots();
      await publish();
    },
  };
}
