import { realpath } from 'node:fs/promises';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import { isDurableRootId } from '@brainstrike/file-system';
import { type DatabaseLocation, joinProfileDirectory } from './node-workspace/database-location.js';

/** Structural borrow of HostStartupContext; it cannot acquire or release Root. */
export interface NodeWorkspaceServicesStartup {
  register(close: () => Promise<void>): Promise<void>;
  readonly signal: AbortSignal;
  readonly store: {
    readonly lock: {
      readonly isReleased: boolean;
      /** Acquisition-time identity; the store's presentation path may be retargeted. */
      readonly owner: { readonly root: string };
    };
    readonly root: string;
  };
}

/** The existing selected location, not a request to derive a profile from cwd. */
export type NodeWorkspaceProfileSelection = DatabaseLocation;

/** Existing owners provide these operations; this borrower constructs no store or mount. */
export interface NodeWorkspaceProfileOwner<TDatabase> {
  borrowSourceRoot(rootId: string): Promise<CanonicalWorkspaceLease>;
  close(): Promise<void>;
  readonly database: TDatabase;
  readonly location: NodeWorkspaceProfileSelection;
  readonly profileDirectory: string;
  readRoots(): Promise<readonly RuntimeWorkspaceRoot[]>;
}

export interface NodeWorkspaceServices<TDatabase> {
  borrowRoot(rootId: string): Promise<CanonicalWorkspaceLease>;
  close(): Promise<void>;
  readonly location: NodeWorkspaceProfileSelection;
  readonly profileDirectory: string;
  readRoots(): Promise<readonly RuntimeWorkspaceRoot[]>;
  revalidate(rootIds: readonly string[]): Promise<readonly RuntimeWorkspaceRoot[]>;
  /** Retain a catalog operation through the existing owner's complete database surface. */
  withCatalog<T>(operation: (database: TDatabase) => Promise<T>): Promise<T>;
}

/**
 * CLI prerequisite6051526779: borrow the selected existing profile and pinned mounts
 * under the already acquired canonical Root. The owner factory must register any
 * partial acquisition before its first side effect through this same startup.
 */
export async function openNodeWorkspaceServices<TDatabase>(
  startup: NodeWorkspaceServicesStartup,
  acquireProfile: (
    startup: NodeWorkspaceServicesStartup
  ) => Promise<NodeWorkspaceProfileOwner<TDatabase>>
): Promise<NodeWorkspaceServices<TDatabase>> {
  const borrower = new NodeWorkspaceBorrower<TDatabase>(startup);
  await startup.register(() => borrower.close());
  try {
    await borrower.initialize(acquireProfile);
  } catch (cause) {
    try {
      await borrower.close();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Workspace acquisition and cleanup failed.');
    }
    throw cause;
  }
  return borrower;
}

class NodeWorkspaceBorrower<TDatabase> implements NodeWorkspaceServices<TDatabase> {
  private owner: NodeWorkspaceProfileOwner<TDatabase> | undefined;
  private closing: Promise<void> | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly borrows = new Map<string, Promise<CanonicalWorkspaceLease>>();
  private readonly leases = new Set<CanonicalWorkspaceLease>();
  private readonly partialClosers: (() => Promise<void>)[] = [];

  constructor(private readonly startup: NodeWorkspaceServicesStartup) {}

  initialize(
    acquireProfile: (
      startup: NodeWorkspaceServicesStartup
    ) => Promise<NodeWorkspaceProfileOwner<TDatabase>>
  ): Promise<void> {
    return this.own(async () => {
      const owner = await acquireProfile({
        ...this.startup,
        register: async (close) => {
          this.partialClosers.push(close);
          this.assertActive();
        },
      });
      this.owner = owner;
      const directory = await realpath(owner.profileDirectory);
      const expected = await realpath(
        joinProfileDirectory(owner.location.rootPath, owner.location.profile)
      );
      const acquiredRoot = this.startup.store.lock.owner.root;
      if (directory !== expected || directory !== acquiredRoot) {
        throw new Error('Selected profile does not belong to the acquired canonical Root.');
      }
    });
  }

  get location(): NodeWorkspaceProfileSelection {
    return this.currentOwner().location;
  }

  get profileDirectory(): string {
    return this.currentOwner().profileDirectory;
  }

  readRoots(): Promise<readonly RuntimeWorkspaceRoot[]> {
    return this.own(() => this.currentOwner().readRoots());
  }

  revalidate(rootIds: readonly string[]): Promise<readonly RuntimeWorkspaceRoot[]> {
    return this.own(async () => {
      const roots = await this.currentOwner().readRoots();
      return Promise.all(
        rootIds.map(async (rootId) => {
          const root = this.selectedRoot(roots, rootId);
          const captured = this.borrows.get(rootId);
          if (captured) {
            await this.assertPinnedRoot(root, await captured);
          }
          return root;
        })
      );
    });
  }

  borrowRoot(rootId: string): Promise<CanonicalWorkspaceLease> {
    return this.own(async () => {
      const owner = this.currentOwner();
      const root = this.selectedRoot(await owner.readRoots(), rootId);
      let borrow = this.borrows.get(rootId);
      if (!borrow) {
        borrow = owner.borrowSourceRoot(rootId).then((lease) => {
          this.leases.add(lease);
          return lease;
        });
        this.borrows.set(rootId, borrow);
      }
      const lease = await borrow;
      await this.assertPinnedRoot(root, lease);
      // A catalog disconnect during the asynchronous borrow must not publish the lease.
      const current = this.selectedRoot(await owner.readRoots(), rootId);
      if (current.path !== root.path) {
        throw new Error('Selected catalog root changed during its pinned borrow.');
      }
      lease.signal.throwIfAborted();
      return lease;
    });
  }

  withCatalog<T>(operation: (database: TDatabase) => Promise<T>): Promise<T> {
    return this.own(() => operation(this.currentOwner().database));
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled([...this.leases].map((lease) => lease.retire()));
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Pinned workspace borrows could not retire.');
      }
      await this.owner?.close();
      for (const close of this.partialClosers.toReversed()) {
        await close();
      }
    });
    return this.closing;
  }

  private async assertPinnedRoot(
    root: RuntimeWorkspaceRoot,
    lease: CanonicalWorkspaceLease
  ): Promise<void> {
    lease.signal.throwIfAborted();
    if (lease.rootId !== root.rootId || lease.canonicalPath !== (await realpath(root.path))) {
      throw new Error('Selected catalog root does not match its pinned canonical mount.');
    }
    lease.signal.throwIfAborted();
  }

  private selectedRoot(
    roots: readonly RuntimeWorkspaceRoot[],
    rootId: string
  ): RuntimeWorkspaceRoot {
    if (!isDurableRootId(rootId)) {
      throw new Error('Workspace selection requires an existing canonical root ID.');
    }
    const matches = roots.filter((root) => root.rootId === rootId);
    if (matches.length !== 1 || !matches[0]) {
      throw new Error('Selected workspace root is unavailable in the live catalog.');
    }
    return matches[0];
  }

  private currentOwner(): NodeWorkspaceProfileOwner<TDatabase> {
    this.assertActive();
    if (!this.owner) {
      throw new Error('Existing profile owner has not been acquired.');
    }
    return this.owner;
  }

  private assertActive(): void {
    this.startup.signal.throwIfAborted();
    if (this.closing || this.startup.store.lock.isReleased) {
      throw new Error('Node workspace services are closing or their Root was released.');
    }
  }

  private own<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.assertActive();
    } catch (cause) {
      return Promise.reject(cause);
    }
    const pending = Promise.resolve()
      .then(operation)
      .then((value) => {
        this.assertActive();
        return value;
      });
    this.pending.add(pending);
    return pending.finally(() => this.pending.delete(pending));
  }
}

export * from './node-workspace/database-corruption-classifier.js';
export * from './node-workspace/database-location.js';
export { DatabaseCloseError, isWasmAbortError } from './node-workspace/database-owner-errors.js';
export * from './node-workspace/db-clean-shutdown-marker.js';
export * from './node-workspace/db-runtime-env.js';
export * from './node-workspace/existing-profile-services.js';
export * from './node-workspace/file-not-found-error.js';
export * from './node-workspace/pg-data-version.js';
export * from './node-workspace/profile-database-owner.js';
export * from './node-workspace/read-denial-diagnostic.js';
export * from './node-workspace/workspace-recent-roots.js';
export * from './node-workspace/workspace-root-availability.js';
export * from './node-workspace/workspace-root-mounts.js';
export * from './node-workspace/workspace-root-paths.js';
export * from './node-workspace/workspace-root-read.js';
export * from './node-workspace/workspace-root-registry.js';
export * from './node-workspace/workspace-root-seams.js';
export * from './node-workspace/workspace-root-source-lease.js';
export * from './node-workspace/workspace-root-store.js';
export * from './node-workspace/workspace-root-types.js';
export * from './node-workspace/workspace-roots.js';
export * from './node-workspace/write-file-atomically.js';
