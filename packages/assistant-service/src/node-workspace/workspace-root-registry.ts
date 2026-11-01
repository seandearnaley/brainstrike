import path from 'node:path';
import type {
  CanonicalSourceSubscription,
  CanonicalWorkspaceLease,
} from '@brainstrike/canonical-ingestion';
import { type DirectoryHandle, isDurableRootId } from '@brainstrike/file-system';
import { descriptorFor } from '@brainstrike/file-system/workspace-root-nodes';
import { createLogger } from '@brainstrike/logging';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import type { RecentRootEntry, RootDescriptor } from '@brainstrike/types';
import { NativeAuthorityTransitionError } from '../node-native-index/errors.ts';
import {
  listRecentRootEntries,
  type ManagedWorktreeAuthorizer,
  readRecentRootsOrQuarantine,
  recordRecentRoot,
  recordRestoredRecentRoots,
  resolveGrantedRootHandle,
} from './workspace-recent-roots.ts';
import { WorkspaceRootAvailability } from './workspace-root-availability.ts';
import {
  findRecordedWorkspaceRoot,
  markRootsDisconnectedExcept,
  recordedRoot,
  recordRestoredWorkspaceRoots,
  recordWorkspaceRoot,
} from './workspace-root-catalog.ts';
import {
  cleanupWorkspaceRootResources,
  convergeWorkspaceRootCatalog,
  type WorkspaceRootResourceOwners,
} from './workspace-root-cleanup.ts';
import { WorkspaceRootMountTable } from './workspace-root-mounts.ts';
import { WorkspaceRootMutationLifetime } from './workspace-root-mutation-lifetime.ts';
import { pathKey, pathsEqual } from './workspace-root-paths.ts';
import {
  assertNativeAbsoluteReadPath,
  resolveReadAgainstMountedRoot,
} from './workspace-root-read.ts';
import { workspaceRootRegistryDisposed } from './workspace-root-registry-disposed.ts';
import { createNativeSecureRoot, resolveValidatedReadPath } from './workspace-root-seams.ts';
import { createWorkspaceRootSourceLease } from './workspace-root-source-lease.ts';
import type {
  MountedWorkspaceRoot,
  RecordedWorkspaceRoot,
  RootDataDeletionReservation,
  SecureWorkspaceRoot,
  StoredWorkspaceRoot,
  WorkspaceRootRegistryOptions,
} from './workspace-root-types.ts';

export * from './workspace-root-registry-disposed.ts';
export type {
  SecureWorkspaceRoot,
  StoredWorkspaceRoot,
  WorkspaceRootRegistryOptions,
} from './workspace-root-types.ts';

export type SubscribeMountedWorkspaceRoot = (
  mounted: MountedWorkspaceRoot,
  ...args: Parameters<CanonicalWorkspaceLease['subscribe']>
) => Promise<CanonicalSourceSubscription>;

const logger = createLogger('WorkspaceRootRegistry');

interface AddRootOptions {
  /**
   * The person chose this folder in the picker: a recorded path that now resolves to another
   * folder is re-pinned to it. A reopen without the picker refuses that folder instead.
   */
  readonly grantedAfresh?: boolean;
  readonly recordInRecentRoots?: boolean;
}

/** A recorded folder whose path no longer resolves to the folder it was granted under. */
export class WorkspaceRootIdentityChangedError extends Error {
  constructor() {
    super('The workspace folder at this path is not the one that was granted; reconnect it.');
    this.name = 'WorkspaceRootIdentityChangedError';
  }
}

export class WorkspaceRootRegistry {
  private readonly createSecureRoot: (rootPath: string) => Promise<SecureWorkspaceRoot>;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readonly resources: WorkspaceRootResourceOwners;
  private readonly getRootsCatalog: () => Promise<WorkspaceRootPort>;
  private readonly isExpectedCatalogRefusal: ((error: unknown) => boolean) | undefined;
  private managedWorktreeAuthorizer: ManagedWorktreeAuthorizer | null = null;
  private readonly mounts = new WorkspaceRootMountTable();
  private readonly availability = new WorkspaceRootAvailability();
  private readonly mutations = new WorkspaceRootMutationLifetime();
  private rootDataDeletion: RootDataDeletionReservation | undefined;
  private readonly retiringSourceRoots = new WeakSet<MountedWorkspaceRoot>();
  private readonly sourceLeases = new Set<{
    readonly lease: CanonicalWorkspaceLease;
    readonly mounted: MountedWorkspaceRoot;
  }>();
  /** Work running on a mounted handle; the mount's retirement waits for it before closing. */
  private readonly mountUses = new Set<{
    readonly done: Promise<unknown>;
    readonly mounted: MountedWorkspaceRoot;
  }>();
  private readonly onRootGranted: ((grantedPath: string) => void) | undefined;
  private readonly pathExists: (rootPath: string) => Promise<boolean>;
  private readonly resolveReadPath: (
    requestedPath: string,
    canonicalRoot: string
  ) => Promise<string>;
  private readonly recents: WorkspaceRootRegistryOptions['recents'];

  constructor(options: WorkspaceRootRegistryOptions) {
    this.createSecureRoot = options.createSecureRoot ?? createNativeSecureRoot;
    this.resources = {
      disposeCommandSessionsForRoot: options.disposeCommandSessionsForRoot,
      evictLspServersForRoot: options.evictLspServersForRoot,
    };
    this.getRootsCatalog = options.getRootsCatalog;
    this.isExpectedCatalogRefusal = options.isExpectedCatalogRefusal;
    this.onRootGranted = options.onRootGranted;
    this.pathExists = options.pathExists;
    this.resolveReadPath = options.resolveReadPath ?? resolveValidatedReadPath;
    this.recents = options.recents;
  }

  /** A folder the person chose in the picker. */
  addRoot(handle: DirectoryHandle, options: AddRootOptions = {}): Promise<RootDescriptor> {
    return this.serializeMutation(() =>
      this.addRootOwned(handle, { grantedAfresh: true, ...options })
    );
  }

  private async addRootOwned(
    handle: DirectoryHandle,
    { grantedAfresh = false, recordInRecentRoots = true }: AddRootOptions
  ): Promise<RootDescriptor> {
    const presentationPath = path.normalize(handle.path);
    // Read the catalog before opening the probe so a failed read cannot leak it.
    // serializeMutation already orders callers; these reads need no parallelism.
    const entries = await this.readOpenRoots();
    // Read the recent-root ledger before mounting or persisting to avoid partial
    // success on storage failure. The same flag guards its later invariant check.
    const recentRootEntries = recordInRecentRoots
      ? await readRecentRootsOrQuarantine(this.recents)
      : null;
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- sequencing is the leak fix: the probe may only be opened once the store reads above have succeeded, so the try/finally owns it from the instant it exists.
    const probe = await this.createSecureRoot(presentationPath);
    let probeAdopted = false;
    try {
      // A dispose that lands while the probe was opening must fail this call the same way
      // mount() does, rather than returning a granted descriptor for a torn-down registry.
      this.assertActive();
      const canonicalPath = path.normalize(probe.canonicalPath);
      const mountedMatch = this.mounts.findByCanonicalPath(canonicalPath);
      const existing = this.findExistingStoredRoot(entries, mountedMatch, canonicalPath);

      const db = await this.getRootsCatalog();
      // Reuse the retained folder identity after disconnect, including path aliases (BST-1990).
      const recorded = await findRecordedWorkspaceRoot(db, existing, (records) =>
        this.findExistingStoredRoot(records, undefined, canonicalPath)
      );
      const rootId = await recordWorkspaceRoot(
        db,
        {
          canonicalPath,
          path: recorded?.path ?? presentationPath,
          preferredId: recorded?.rootId ?? mountedMatch?.rootId ?? crypto.randomUUID(),
        },
        // Without the picker, the store refuses a recorded path that now resolves elsewhere.
        grantedAfresh
      );
      const entry: RecordedWorkspaceRoot = {
        addedAt: Date.now(),
        canonicalPath,
        path: recorded?.path ?? presentationPath,
        rootId,
      };

      // reconcileAddMount owns the probe: it adopts it or closes it as redundant.
      await this.reconcileAddMount(entry, mountedMatch, probe).catch(async (error: unknown) => {
        // The record must not stay live without its mount, nor open unless it already was.
        await this.convergeDatabase(existing ? [] : [rootId]);
        throw error;
      });
      probeAdopted = true;

      // Registering the record opened it, in the same commit.
      this.mounts.clearSessionMount(entry.rootId);
      if (recordInRecentRoots) {
        // Retain the ledger read before mounting; a missing snapshot is an
        // invariant failure, never permission to overwrite the ledger as empty.
        if (recentRootEntries === null) {
          throw new Error(
            'Invariant violated: recentRootEntries must be populated when recordInRecentRoots is true.'
          );
        }
        // Passes the entries read above rather than letting recordRecentRoot re-read them — the
        // hoist's whole point is that this write can no longer fail on an
        // I/O problem the read above would already have surfaced.
        await recordRecentRoot(this.recents, entry.path, undefined, recentRootEntries);
        // Same gate as the ledger write above (BST-1393 review finding): a
        // managed-worktree mount passes recordInRecentRoots: false and must
        // not reach the OS recent-documents list either — the registry
        // already decided it doesn't belong in Recents.
        this.onRootGranted?.(entry.path);
      }
      return descriptorFor(entry, 'granted', true);
    } finally {
      if (!probeAdopted) {
        try {
          probe.close();
        } catch (error) {
          logger.warn('Failed to close a redundant workspace root probe', { error });
        }
      }
    }
  }

  addRootByPath(requestedPath: string): Promise<RootDescriptor> {
    return this.serializeMutation(async () => {
      const granted = await resolveGrantedRootHandle(
        this.recents,
        requestedPath,
        this.managedWorktreeAuthorizer ?? undefined
      );
      const descriptor = await this.addRootOwned(granted.handle, {
        grantedAfresh: false,
        recordInRecentRoots: granted.grantSource === 'recents',
      });
      if (granted.grantSource === 'managed-worktree') {
        logger.info('Mounted managed worktree without picker', {
          path: granted.handle.path,
          rootId: descriptor.rootId,
        });
      }
      return descriptor;
    });
  }

  prepareClose(): Promise<void> {
    return this.mutations.prepareClose();
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.disposal ??= this.retireSourceLeases()
      .finally(async () => {
        // Join mutations before closing mounts, even if source retirement failed.
        await this.mutations.settled;
      })
      .then(() => {
        this.mounts.closeAll();
        this.availability.clear();
      })
      .finally(() => {
        this.disposal = undefined;
      });
    return this.disposal;
  }

  async borrowSourceRootForPath(
    requestedPath: string,
    subscribe: SubscribeMountedWorkspaceRoot
  ): Promise<CanonicalWorkspaceLease> {
    assertNativeAbsoluteReadPath(requestedPath, 'Watched root path');
    if (this.rootDataDeletion) {
      throw new Error('Root data deletion owns workspace read admission.');
    }
    await this.mutations.settled;
    this.assertActive();
    const mounted = this.mounts.findByEitherPath(requestedPath);
    if (!mounted) {
      throw new Error('A root watch requires an exact mounted root.');
    }
    const resolved = await resolveReadAgainstMountedRoot(
      requestedPath,
      mounted,
      this.resolveReadPath
    );
    if (resolved.relativePath !== '.' || resolved.traversedSymlink) {
      throw new Error('A root watch requires the same canonical mounted root.');
    }
    return this.borrowMountedSourceRoot(mounted, subscribe);
  }

  private borrowMountedSourceRoot(
    mounted: MountedWorkspaceRoot,
    subscribe: SubscribeMountedWorkspaceRoot
  ): CanonicalWorkspaceLease {
    const rootId = mounted.rootId;
    this.assertActive();
    if (
      this.mounts.get(rootId) !== mounted ||
      this.retiringSourceRoots.has(mounted) ||
      this.rootDataDeletion?.mounted === mounted
    ) {
      throw new Error('Mounted source root changed during acquisition.');
    }
    const lease = createWorkspaceRootSourceLease({
      assertCurrent: () => {
        this.assertActive();
        if (
          this.mounts.get(rootId) !== mounted ||
          this.retiringSourceRoots.has(mounted) ||
          this.rootDataDeletion?.mounted === mounted
        ) {
          // The owner took the mount back (removal, replacement, root data deletion): the
          // borrower's work is superseded, typed so, like the lease's own retirement.
          throw new NativeAuthorityTransitionError('Mounted source lease was revoked or replaced.');
        }
      },
      mounted,
      resolveReadPath: this.resolveReadPath,
      subscribe: (...args) => subscribe(mounted, ...args),
    });
    const entry = { lease, mounted };
    const owned: CanonicalWorkspaceLease = {
      canonicalPath: lease.canonicalPath,
      generation: lease.generation,
      listDir: (relativePath, maxEntries, context) =>
        lease.listDir(relativePath, maxEntries, context),
      readFile: (relativePath, maxBytes, context) =>
        lease.readFile(relativePath, maxBytes, context),
      retire: async () => {
        await lease.retire();
        this.sourceLeases.delete(entry);
      },
      rootId: lease.rootId,
      signal: lease.signal,
      subscribe: (...args) => lease.subscribe(...args),
    };
    this.sourceLeases.add(entry);
    return owned;
  }

  /**
   * Runs `use` on the folder's mounted handle, the one this registry opened at grant. Refused
   * once the folder is not mounted, is being retired, or holds a root data deletion; the mount
   * closes only after `use` settles.
   */
  async useMountedRoot<T>(
    rootId: string,
    use: (mounted: MountedWorkspaceRoot) => Promise<T>
  ): Promise<T> {
    this.assertActive();
    const mounted = this.mounts.get(rootId);
    if (
      !mounted ||
      this.retiringSourceRoots.has(mounted) ||
      this.rootDataDeletion?.mounted === mounted
    ) {
      throw new NativeAuthorityTransitionError('The folder is not mounted in the workspace.');
    }
    const done = use(mounted);
    const entry = { done, mounted };
    this.mountUses.add(entry);
    try {
      return await done;
    } finally {
      this.mountUses.delete(entry);
    }
  }

  private async retireSourceLeases(mounted?: MountedWorkspaceRoot): Promise<void> {
    // Fence path borrows still resolving this exact mount before capturing its leases.
    // Failed retirement keeps admission closed until the owned cleanup is retried.
    if (mounted) {
      this.retiringSourceRoots.add(mounted);
    }
    const entries = [...this.sourceLeases].filter(
      (entry) => mounted === undefined || entry.mounted === mounted
    );
    const uses = [...this.mountUses].filter(
      (entry) => mounted === undefined || entry.mounted === mounted
    );
    const results = await Promise.allSettled([
      ...entries.map(async (entry) => {
        await entry.lease.retire();
        this.sourceLeases.delete(entry);
      }),
      // A use's own failure is its caller's; the mount only waits for it to end.
      ...uses.map((entry) =>
        entry.done.then(
          () => undefined,
          () => undefined
        )
      ),
    ]);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Mounted source lease retirement failed.');
    }
  }

  private async unmountSourceRoot(rootId: string): Promise<void> {
    const mounted = this.mounts.get(rootId);
    if (mounted) {
      await this.retireSourceLeases(mounted);
    }
    this.mounts.unmount(rootId);
  }

  listRecentRoots(): Promise<readonly RecentRootEntry[]> {
    return this.serializeMutation(() => listRecentRootEntries(this.recents));
  }

  /**
   * The open folders mounted now, each with the canonical path its handle pinned at grant. A
   * folder whose data is being deleted is absent.
   */
  mountedRoots(): readonly { canonicalPath: string; path: string; rootId: string }[] {
    const persisted = this.mounts.persistedIds();
    return this.mounts
      .snapshot()
      .filter(
        (mounted) => persisted.has(mounted.rootId) && !this.isDeletingRootData(mounted.rootId)
      )
      .map((mounted) => ({
        canonicalPath: mounted.canonicalPath,
        path: mounted.presentationPath,
        rootId: mounted.rootId,
      }));
  }

  /** Whether a root data deletion holds this folder: from its reservation until its release. */
  isDeletingRootData(rootId: string): boolean {
    return this.rootDataDeletion?.mounted.rootId === rootId;
  }

  reserveRootDataDeletion(rootId: string): RootDataDeletionReservation {
    this.assertActive();
    this.mutations.assertAdmission();
    if (!isDurableRootId(rootId)) {
      throw new Error('Root data deletion requires a durable root ID.');
    }
    if (this.rootDataDeletion) {
      throw new Error('A root data deletion already owns the mounted registry.');
    }
    const mounted = this.mounts.get(rootId);
    if (!mounted) {
      throw new Error('Root data deletion requires an actually mounted root.');
    }
    const assertCurrent = (): void => {
      this.assertActive();
      if (this.rootDataDeletion !== reservation || this.mounts.get(rootId) !== mounted) {
        throw new Error('The captured root data deletion grant was replaced or retired.');
      }
    };
    const lifetime = this.mutations.reserve();
    const reservation: RootDataDeletionReservation = {
      assertCurrent,
      disconnect: async () => {
        assertCurrent();
        await this.removeRootOwned(rootId, true);
      },
      mounted,
      release: () => {
        if (this.rootDataDeletion !== reservation) {
          throw new Error('Root deletion cannot release a different reservation.');
        }
        this.rootDataDeletion = undefined;
        lifetime.release();
      },
      retireSources: async () => {
        assertCurrent();
        await this.retireSourceLeases(mounted);
        await this.cleanupRootResources([rootId], true);
        assertCurrent();
      },
      run: (operation) =>
        lifetime.track(
          this.serializeMutation(async () => {
            assertCurrent();
            await operation();
          }, reservation)
        ),
    };
    this.rootDataDeletion = reservation;
    return reservation;
  }

  /** Resolves whether the removal retired a mounted folder. */
  removeRoot(rootId: string): Promise<boolean> {
    return this.serializeMutation(() => this.removeRootOwned(rootId));
  }

  private async removeRootOwned(rootId: string, resourcesRetired = false): Promise<boolean> {
    const mounted = this.mounts.get(rootId);
    if (mounted) {
      await this.retireSourceLeases(mounted);
    }
    // Closing the folder and disconnecting it commit together, so nothing needs a rollback.
    const disconnected = await markRootsDisconnectedExcept(
      await this.getRootsCatalog(),
      this.mounts.persistedMountedPaths(rootId),
      [rootId]
    );
    this.mounts.clearSessionMount(rootId);
    await this.unmountSourceRoot(rootId);
    if (!resourcesRetired) {
      await this.cleanupRootResources([...new Set([rootId, ...disconnected.map((row) => row.id)])]);
    }
    this.availability.forget(rootId);
    return mounted !== undefined;
  }

  /** Mounts the folders the person has open, in their order; one that cannot mount stays open. */
  restoreRoots(): Promise<RootDescriptor[]> {
    return this.serializeMutation(() => this.restoreRootsOwned());
  }

  private async restoreRootsOwned(): Promise<RootDescriptor[]> {
    const entries = await this.readOpenRoots();
    this.availability.retain(entries);
    const descriptors: RootDescriptor[] = [];
    const retainedRootIds = this.mounts.sessionMountIds();
    const retainedCanonicalPaths = new Set<string>();
    const duplicateRootIds: string[] = [];
    const recentRootCandidates: RecordedWorkspaceRoot[] = [];

    for (const entry of entries) {
      // eslint-disable-next-line react-doctor/async-await-in-loop -- mounts are intentionally serial: each iteration's canonical-alias dedup and session-supersession bookkeeping depends on the mounts installed by prior iterations.
      const mountResult = await this.availability.tryMount(entry, this.pathExists, (stored) =>
        this.mount(stored)
      );
      if (!mountResult.ok) {
        descriptors.push(descriptorFor(entry, 'unknown'));
        continue;
      }
      const { canonicalPath } = mountResult;
      if (retainedCanonicalPaths.has(pathKey(canonicalPath))) {
        logger.warn('Closing a duplicate open alias for the same workspace root', {
          rootId: entry.rootId,
        });
        await this.unmountSourceRoot(entry.rootId);
        duplicateRootIds.push(entry.rootId);
        continue;
      }
      // A session mint of the same canonical path is superseded by the persisted identity.
      await this.supersedeSessionMountsFor(entry, canonicalPath, retainedRootIds);
      retainedCanonicalPaths.add(pathKey(canonicalPath));
      retainedRootIds.add(entry.rootId);
      recentRootCandidates.push(entry);
      descriptors.push(descriptorFor(entry, 'granted'));
    }

    for (const mountedRootId of this.mounts.ids()) {
      if (!retainedRootIds.has(mountedRootId)) {
        await this.unmountSourceRoot(mountedRootId);
      }
    }
    await recordRestoredRecentRoots(this.recents, this.getRootsCatalog, recentRootCandidates);
    await recordRestoredWorkspaceRoots(this.getRootsCatalog, recentRootCandidates);
    await this.convergeDatabase(duplicateRootIds);
    return descriptors;
  }

  setManagedWorktreeAuthorizer(authorizer: ManagedWorktreeAuthorizer | null): void {
    this.managedWorktreeAuthorizer = authorizer;
  }

  private cleanupRootResources(rootIds: readonly string[], strict = false): Promise<void> {
    return cleanupWorkspaceRootResources(this.resources, rootIds, strict);
  }

  /** The folders the person has open, in their order, as the catalog records them. */
  private async readOpenRoots(): Promise<RecordedWorkspaceRoot[]> {
    const { roots } = await (await this.getRootsCatalog()).workspaceRoots({
      operation: 'list-open',
    });
    return roots.map(recordedRoot);
  }

  /** Disconnects every record that is not mounted; `closeRootIds` also leave the open list. */
  private convergeDatabase(closeRootIds: readonly string[] = []): Promise<void> {
    return convergeWorkspaceRootCatalog({
      cleanup: (rootIds) => this.cleanupRootResources(rootIds),
      closeRootIds,
      getRootsCatalog: this.getRootsCatalog,
      isExpectedCatalogRefusal: this.isExpectedCatalogRefusal,
      mountedPaths: this.mounts.persistedMountedPaths(),
    });
  }

  /** The recorded folder with this identity: the mounted match's own record wins. */
  private findExistingStoredRoot(
    entries: readonly RecordedWorkspaceRoot[],
    mountedMatch: MountedWorkspaceRoot | undefined,
    canonicalPath: string
  ): RecordedWorkspaceRoot | undefined {
    // The mounted match's own persisted entry (if any) always wins over an
    // incidental identity match on some other stored alias — order in
    // `entries` must never decide which stored root a live mount owns.
    if (mountedMatch) {
      const owned = entries.find((candidate) => candidate.rootId === mountedMatch.rootId);
      if (owned) {
        return owned;
      }
    }
    return entries.find(
      (candidate) =>
        !this.mounts.has(candidate.rootId) && pathsEqual(candidate.canonicalPath, canonicalPath)
    );
  }

  private async retireMount(rootId: string): Promise<void> {
    this.mounts.clearSessionMount(rootId);
    await this.unmountSourceRoot(rootId);
    await this.cleanupRootResources([rootId]);
  }

  private async reconcileAddMount(
    entry: StoredWorkspaceRoot,
    mountedMatch: MountedWorkspaceRoot | undefined,
    probe: SecureWorkspaceRoot
  ): Promise<void> {
    if (mountedMatch && mountedMatch.rootId !== entry.rootId) {
      // Any other mount of this canonical path is superseded — normally a
      // session mint (the stored entry remounts on next restore). Retiring
      // it runs the same LSP/command-session cleanup every other
      // retirement path performs.
      await this.retireMount(mountedMatch.rootId);
    }
    await this.installSourceRoot(entry, probe);
  }

  private async installSourceRoot(
    entry: StoredWorkspaceRoot,
    root: SecureWorkspaceRoot
  ): Promise<string> {
    const current = this.mounts.get(entry.rootId);
    if (
      current &&
      !(
        pathsEqual(current.canonicalPath, root.canonicalPath) &&
        pathsEqual(current.presentationPath, entry.path)
      )
    ) {
      await this.retireSourceLeases(current);
    }
    this.assertActive();
    const canonicalPath = this.mounts.install(entry, root);
    this.availability.forget(entry.rootId);
    return canonicalPath;
  }

  private async mount(entry: RecordedWorkspaceRoot): Promise<string> {
    this.assertActive();
    // Mount-then-ask: the capability's handle-derived canonicalPath is the
    // identity authority; no pre-open path lookup vouches for it.
    const secureRoot = await this.createSecureRoot(entry.path);
    if (this.disposed) {
      try {
        secureRoot.close();
      } catch (error) {
        logger.warn('Failed to close a workspace root capability during disposal', { error });
      }
      this.assertActive();
    }
    try {
      // The folder was pinned when it was granted; a reopen that resolves elsewhere (a symlink
      // swapped in at its path) is refused, never adopted. It stays open, needing reconnect.
      if (!pathsEqual(path.normalize(secureRoot.canonicalPath), entry.canonicalPath)) {
        throw new WorkspaceRootIdentityChangedError();
      }
      return await this.installSourceRoot(entry, secureRoot);
    } catch (error) {
      secureRoot.close();
      throw error;
    }
  }

  private async supersedeSessionMountsFor(
    entry: StoredWorkspaceRoot,
    canonicalPath: string,
    retainedRootIds: Set<string>
  ): Promise<void> {
    for (const candidate of this.mounts.snapshot()) {
      if (
        candidate.rootId !== entry.rootId &&
        this.mounts.isSessionMount(candidate.rootId) &&
        pathsEqual(candidate.canonicalPath, canonicalPath)
      ) {
        retainedRootIds.delete(candidate.rootId);
        // eslint-disable-next-line react-doctor/async-await-in-loop -- retirement is intentionally serial: capability close must precede resource cleanup, and the mounted map is mutated while iterating a snapshot.
        await this.retireMount(candidate.rootId);
      }
    }
  }

  private serializeMutation<T>(
    operation: () => Promise<T>,
    deletion?: RootDataDeletionReservation
  ): Promise<T> {
    return this.mutations.run(
      operation,
      () => {
        this.assertActive();
        if (this.rootDataDeletion && this.rootDataDeletion !== deletion) {
          throw new Error('Root data deletion owns workspace mutation admission.');
        }
      },
      deletion !== undefined && deletion === this.rootDataDeletion
    );
  }

  private assertActive(): void {
    if (this.disposed) {
      throw workspaceRootRegistryDisposed();
    }
  }
}
