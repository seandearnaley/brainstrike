import path from 'node:path';
import { NativeAuthorityTransitionError } from '@brainstrike/assistant-service/node-native-text-services';
import {
  createNativeSecureRoot,
  createWorkspaceRootSourceLease,
  type MountedWorkspaceRoot,
  resolveValidatedReadPath,
  type SecureWorkspaceRoot,
  type SubscribeMountedWorkspaceRoot,
  WorkspaceRootMountTable,
} from '@brainstrike/assistant-service/node-workspace-services';
import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import { CanonicalOperationCancelledError } from '@brainstrike/canonical-ingestion/cancellation';
import { createLogger } from '@brainstrike/logging';
import type { SourceCatalogPort, WorkspaceRootPort } from '@brainstrike/state-store';

const logger = createLogger('IndexSourceRoots');

/** A folder the host's root registry mounted, with the canonical path its handle pinned at grant. */
export interface HostMountedRoot {
  readonly canonicalPath: string;
  readonly path: string;
  readonly rootId: string;
}

export interface IndexSourceRootsOptions {
  /** Test seam; production opens each folder with `SecureRoot`. */
  readonly createSecureRoot?: (rootPath: string) => Promise<SecureWorkspaceRoot>;
  /** The agent host's `workspace/roots/mounted`: the folders its root registry holds now. */
  readonly readMountedRoots: () => Promise<readonly HostMountedRoot[]>;
}

interface IndexSourceLease {
  readonly lease: CanonicalWorkspaceLease;
  readonly mounted: MountedWorkspaceRoot;
}

export type BorrowIndexSourceRoot = (
  rootId: string,
  subscribe: SubscribeMountedWorkspaceRoot
) => Promise<CanonicalWorkspaceLease>;

/**
 * ADR-0029 stage 4: the read handles Main's native index holds on the folders
 * the agent host keeps live. The host's root registry is the one writer of the
 * folders; this follows its catalog. A folder the host removed first refuses
 * the index's writes at the store (`prepare` needs a live root), then leaves
 * here at the index's next reconfigure, and its leases end as superseded
 * (`NativeAuthorityTransitionError`), which the index answers as cancelled.
 */
export class IndexSourceRoots {
  private readonly createSecureRoot: (rootPath: string) => Promise<SecureWorkspaceRoot>;
  private readonly readMountedRoots: () => Promise<readonly HostMountedRoot[]>;
  private readonly mounts = new WorkspaceRootMountTable();
  private readonly leases = new Set<IndexSourceLease>();
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: IndexSourceRootsOptions) {
    this.createSecureRoot = options.createSecureRoot ?? createNativeSecureRoot;
    this.readMountedRoots = options.readMountedRoots;
  }

  /**
   * Mounts the live folders (retiring the leases of any no longer live), then runs `work` with
   * the ids mounted, in one serialized step: no other sync falls inside.
   */
  borrowLiveRoots<T>(
    work: (rootIds: readonly string[], borrow: BorrowIndexSourceRoot) => Promise<T>
  ): Promise<T> {
    return this.serialize(async () => {
      const rootIds = await this.sync();
      return await work(rootIds, async (rootId, subscribe) => this.borrow(rootId, subscribe));
    });
  }

  /**
   * Follows the host's mounts now: a folder the host no longer holds has its leases retired and
   * its handle closed at once, so a scan in flight on it ends as superseded (D1: the host removes
   * first, and the index learns right after).
   */
  followHost(): Promise<void> {
    return this.serialize(async () => {
      await this.sync();
    });
  }

  /** A lease on a folder mounted by the last sync. */
  borrowSourceRoot(
    rootId: string,
    subscribe: SubscribeMountedWorkspaceRoot
  ): Promise<CanonicalWorkspaceLease> {
    return this.serialize(async () => this.borrow(rootId, subscribe));
  }

  /** Retires every lease and closes every handle. */
  close(): Promise<void> {
    return this.serialize(async () => {
      this.closed = true;
      await this.retire([...this.leases]);
      this.mounts.closeAll();
    });
  }

  private borrow(
    rootId: string,
    subscribe: SubscribeMountedWorkspaceRoot
  ): CanonicalWorkspaceLease {
    this.assertOpen();
    const mounted = this.mounts.get(rootId);
    if (!mounted) {
      throw new NativeAuthorityTransitionError('The folder is no longer live in the workspace.');
    }
    const lease = createWorkspaceRootSourceLease({
      assertCurrent: () => {
        if (this.closed || this.mounts.get(rootId) !== mounted) {
          throw new NativeAuthorityTransitionError('Mounted source lease was revoked or replaced.');
        }
      },
      mounted,
      resolveReadPath: resolveValidatedReadPath,
      subscribe: (...args) => subscribe(mounted, ...args),
    });
    const entry = { lease, mounted };
    this.leases.add(entry);
    return {
      canonicalPath: lease.canonicalPath,
      generation: lease.generation,
      listDir: (relativePath, maxEntries, context) =>
        lease.listDir(relativePath, maxEntries, context),
      readFile: (relativePath, maxBytes, context) =>
        lease.readFile(relativePath, maxBytes, context),
      retire: async () => {
        await lease.retire();
        this.leases.delete(entry);
      },
      rootId: lease.rootId,
      signal: lease.signal,
      subscribe: (...args) => lease.subscribe(...args),
    };
  }

  private async sync(): Promise<string[]> {
    this.assertOpen();
    const live = await this.readMountedRoots();
    const liveById = new Map(live.map((root) => [root.rootId, root]));
    for (const mounted of this.mounts.snapshot()) {
      const current = liveById.get(mounted.rootId);
      if (
        current?.path !== mounted.presentationPath ||
        path.normalize(current.canonicalPath) !== mounted.canonicalPath
      ) {
        await this.retire([...this.leases].filter((entry) => entry.mounted === mounted));
        this.mounts.unmount(mounted.rootId);
      }
    }
    for (const root of live) {
      if (this.mounts.has(root.rootId)) {
        continue;
      }
      let secureRoot: SecureWorkspaceRoot;
      try {
        secureRoot = await this.createSecureRoot(root.path);
      } catch (cause) {
        // The host mounted it a moment ago; one it can no longer open is skipped, and logged.
        logger.warn('The index could not open a live workspace folder', {
          cause,
          rootId: root.rootId,
        });
        continue;
      }
      // The host pinned the folder's identity at grant; a reopen that resolves elsewhere (a
      // swapped symlink) is refused, never adopted.
      if (path.normalize(secureRoot.canonicalPath) !== path.normalize(root.canonicalPath)) {
        secureRoot.close();
        logger.error('Refused a workspace folder whose identity changed since its grant', {
          rootId: root.rootId,
        });
        continue;
      }
      this.mounts.install({ addedAt: 0, path: root.path, rootId: root.rootId }, secureRoot);
    }
    return this.mounts.ids();
  }

  private async retire(entries: readonly IndexSourceLease[]): Promise<void> {
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        await entry.lease.retire();
        this.leases.delete(entry);
      })
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Index source leases did not retire');
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new NativeAuthorityTransitionError('Index source roots are closed.');
    }
  }
}

/**
 * D1 (Sean, 2026-11-01): the host disconnects a removed folder first and the index learns of it
 * afterwards. A scan in flight on that folder is refused at the store (its root is no longer
 * live); that refusal ends the scan as cancelled, never as a failure. A refusal while the folder
 * is still live stays the failure it is.
 */
export function cancelScansOfRemovedRoots<T extends SourceCatalogPort & WorkspaceRootPort>(
  catalog: T
): SourceCatalogPort {
  return {
    sourceCatalog: async (request) => {
      try {
        return await catalog.sourceCatalog(request);
      } catch (cause) {
        if (request.operation !== 'prepare') {
          throw cause;
        }
        const { roots } = await catalog.workspaceRoots({ operation: 'list' });
        if (roots.some((root) => root.id === request.rootId && root.status === 'live')) {
          throw cause;
        }
        throw new CanonicalOperationCancelledError(
          'The folder left the workspace during its scan.',
          {
            cause,
          }
        );
      }
    },
  };
}
