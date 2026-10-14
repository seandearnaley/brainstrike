import { access, realpath } from 'node:fs/promises';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import type {
  NodeWorkspaceProfileOwner,
  NodeWorkspaceServices,
  NodeWorkspaceServicesStartup,
} from '../node-workspace-services.js';
import { openNodeWorkspaceServices } from '../node-workspace-services.js';
import { type DatabaseLocation, joinProfileDirectory } from './database-location.js';
import {
  type SubscribeMountedWorkspaceRoot,
  WorkspaceRootRegistry,
} from './workspace-root-registry.js';
import type { WorkspaceRootStorage } from './workspace-root-types.js';
import { loadWorkspaceRootsFromCatalog } from './workspace-roots.js';

// Keep one cold mount borrower per acquired profile; the existing StateStore owns all records.
const activeProfiles = new Set<string>();

export interface ExistingNodeWorkspaceServicesOptions {
  readonly disposeCommandSessionsForRoot: (rootId: string) => Promise<number>;
  readonly evictLspServersForRoot: (rootId: string) => Promise<void>;
  /** The explicitly selected existing grant owner; no path or storage writer is constructed here. */
  readonly grants: Pick<WorkspaceRootStorage, 'getItem'>;
  /** Location selected by the existing profile authority, before acquiring HostStartupContext. */
  readonly location: DatabaseLocation;
  /** Borrow the existing subscription owner; this service starts no watcher of its own. */
  readonly subscribe: SubscribeMountedWorkspaceRoot;
}

export function openExistingNodeWorkspaceServices<TCatalog extends WorkspaceRootPort>(
  startup: NodeWorkspaceServicesStartup & {
    readonly store: TCatalog & NodeWorkspaceServicesStartup['store'];
  },
  options: ExistingNodeWorkspaceServicesOptions
): Promise<NodeWorkspaceServices<TCatalog>> {
  return openNodeWorkspaceServices(startup, async (ownedStartup) => {
    const location = Object.freeze({ ...options.location });
    const profileDirectory = await realpath(
      joinProfileDirectory(location.rootPath, location.profile)
    );
    const acquiredRoot = ownedStartup.store.lock.owner.root;
    ownedStartup.signal.throwIfAborted();
    if (ownedStartup.store.lock.isReleased || profileDirectory !== acquiredRoot) {
      throw new Error('Selected profile does not belong to the acquired canonical Root.');
    }
    if (activeProfiles.has(profileDirectory)) {
      throw new Error('The existing profile already has a cold workspace owner.');
    }
    const catalog = startup.store;
    let closing: Promise<void> | undefined;
    const readOnlyGrants: WorkspaceRootStorage = {
      getItem: (key) => options.grants.getItem(key),
      removeItem: async () => {
        throw new Error('Cold workspace borrower cannot write preferences.');
      },
      setItem: async () => {
        throw new Error('Cold workspace borrower cannot write preferences.');
      },
    };
    const registry = new WorkspaceRootRegistry({
      disposeCommandSessionsForRoot: options.disposeCommandSessionsForRoot,
      evictLspServersForRoot: options.evictLspServersForRoot,
      getRootsCatalog: async () => catalog,
      pathExists: async (rootPath) => {
        try {
          await access(rootPath);
          return true;
        } catch (cause) {
          if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
            return false;
          }
          throw cause;
        }
      },
      storage: readOnlyGrants,
    });
    const close = (): Promise<void> => {
      closing ??= (async () => {
        await registry.dispose();
        activeProfiles.delete(profileDirectory);
      })();
      return closing;
    };
    activeProfiles.add(profileDirectory);
    // Register mount retirement before restoration; the acquired StateStore remains borrowed.
    await ownedStartup.register(close);
    const owner: NodeWorkspaceProfileOwner<TCatalog> = {
      borrowSourceRoot: (rootId) => registry.borrowSourceRoot(rootId, options.subscribe),
      close,
      database: catalog,
      location,
      profileDirectory,
      readRoots: async () => {
        const descriptors = await registry.restoreRoots({ persistPreferences: false });
        const granted = new Map(
          descriptors
            .filter((entry) => entry.permissionState === 'granted')
            .map((entry) => [entry.rootId, entry.handle.path])
        );
        const roots = await loadWorkspaceRootsFromCatalog(catalog);
        return roots.filter((root) => granted.get(root.rootId) === root.path);
      },
    };
    await owner.readRoots();
    return owner;
  });
}
