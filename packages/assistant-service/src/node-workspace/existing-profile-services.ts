import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { BrainstrikePglite } from '@brainstrike/db/pglite-factory';
import type {
  NodeWorkspaceProfileOwner,
  NodeWorkspaceServices,
  NodeWorkspaceServicesStartup,
} from '../node-workspace-services.js';
import { openNodeWorkspaceServices } from '../node-workspace-services.js';
import { type DatabaseLocation, joinProfileDirectory } from './database-location.js';
import { createNodeProfileDatabaseOwner } from './profile-database-owner.js';
import {
  type SubscribeMountedWorkspaceRoot,
  WorkspaceRootRegistry,
} from './workspace-root-registry.js';
import type { WorkspaceRootStorage } from './workspace-root-types.js';
import { loadWorkspaceRootsFromDatabase, type WorkspaceRootsQueryable } from './workspace-roots.js';

// The legacy PG lock is PID-reentrant. Keep the cold local owner singular too:
// repeated acquisition under one HostStartupContext must not construct another writer.
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

export function openExistingNodeWorkspaceServices(
  startup: NodeWorkspaceServicesStartup,
  options: ExistingNodeWorkspaceServicesOptions
): Promise<NodeWorkspaceServices<BrainstrikePglite>> {
  return openNodeWorkspaceServices(startup, async (ownedStartup) => {
    const location = Object.freeze({ ...options.location });
    const profileDirectory = await realpath(
      joinProfileDirectory(location.rootPath, location.profile)
    );
    ownedStartup.signal.throwIfAborted();
    if (ownedStartup.store.lock.isReleased || profileDirectory !== ownedStartup.store.root) {
      throw new Error('Selected profile does not belong to the acquired canonical Root.');
    }
    // An existing catalog is required; a mistaken selection must never bootstrap another one.
    await access(path.join(profileDirectory, 'pgdata', 'PG_VERSION'));
    if (activeProfiles.has(profileDirectory)) {
      throw new Error('The existing profile already has a cold workspace owner.');
    }
    const databaseOwner = createNodeProfileDatabaseOwner({ getLocation: () => location });
    let database: BrainstrikePglite | undefined;
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
    const rootsDatabase: WorkspaceRootsQueryable = {
      query: async (sql, params) => {
        if (!database) {
          throw new Error('Existing catalog is not open.');
        }
        return await database.query(sql, params ? [...params] : undefined);
      },
    };
    const registry = new WorkspaceRootRegistry({
      disposeCommandSessionsForRoot: options.disposeCommandSessionsForRoot,
      evictLspServersForRoot: options.evictLspServersForRoot,
      getRootsDatabase: async () => rootsDatabase,
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
        await databaseOwner.close();
        activeProfiles.delete(profileDirectory);
      })();
      return closing;
    };
    activeProfiles.add(profileDirectory);
    // The borrower owns this partial join before either the existing PG or native mount opens.
    await ownedStartup.register(close);
    database = await databaseOwner.initialize();
    const owner: NodeWorkspaceProfileOwner<BrainstrikePglite> = {
      borrowSourceRoot: (rootId) => registry.borrowSourceRoot(rootId, options.subscribe),
      close,
      database,
      location,
      profileDirectory,
      readRoots: async () => {
        const descriptors = await registry.restoreRoots({ persistPreferences: false });
        const granted = new Map(
          descriptors
            .filter((entry) => entry.permissionState === 'granted')
            .map((entry) => [entry.rootId, entry.handle.path])
        );
        const roots = await loadWorkspaceRootsFromDatabase(rootsDatabase);
        return roots.filter((root) => granted.get(root.rootId) === root.path);
      },
    };
    await owner.readRoots();
    return owner;
  });
}
