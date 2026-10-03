import path from 'node:path';
import type {
  CanonicalSourceSubscription,
  CanonicalWorkspaceLease,
} from '@brainstrike/canonical-ingestion';
import {
  AccessError,
  type DirectoryHandle,
  type FileHandle,
  type IFileNode,
  isDurableRootId,
} from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { RecentRootEntry, RootDescriptor } from '@brainstrike/types';
import { disposeDesktopCommandSessionsForRoot } from '../assistant-server/command-session-manager';
import { evictLspServersForRoot } from '../assistant-server/lsp-diagnostics';
import {
  markRootsDisconnectedExcept,
  type WorkspaceRootsQueryable,
} from '../assistant-server/workspace-roots';
import { isFileNotFoundError } from '../file-read-errors';
import { projectReadDenialDiagnostic, projectReadDenialError } from './read-denial-diagnostic';
import {
  listRecentRootEntries,
  type ManagedWorktreeAuthorizer,
  readRecentRootsOrQuarantine,
  recordRecentRoot,
  recordRecentRootsIfNew,
  resolveGrantedRootHandle,
} from './workspace-recent-roots';
import { WorkspaceRootMountTable } from './workspace-root-mounts';
import {
  buildDirectoryListing,
  descriptorFor,
  MAX_DIRECTORY_ENTRIES,
} from './workspace-root-nodes';
import { pathKey, pathsEqual } from './workspace-root-paths';
import {
  assertNativeAbsoluteReadPath,
  type ResolvedWorkspaceRead,
  readResolvedWorkspaceFile,
  resolveReadAgainstMountedRoot,
} from './workspace-root-read';
import {
  createNativeSecureRoot,
  resolveCanonicalRootPath,
  resolveValidatedReadPath,
} from './workspace-root-seams';
import { createWorkspaceRootSourceLease } from './workspace-root-source-lease';
import {
  clearLastFolderIfMatches,
  readLastFolder,
  readStoredRoots,
  readStoredRootsOrQuarantine,
  writeLastFolder,
  writeLastFolderBestEffort,
  writeStoredRoots,
} from './workspace-root-store';
import type {
  MountedWorkspaceRoot,
  SecureWorkspaceRoot,
  StoredWorkspaceRoot,
} from './workspace-root-types';

export type { SecureWorkspaceRoot, StoredWorkspaceRoot } from './workspace-root-types';

export type SubscribeMountedWorkspaceRoot = (
  mounted: MountedWorkspaceRoot,
  ...args: Parameters<CanonicalWorkspaceLease['subscribe']>
) => Promise<CanonicalSourceSubscription>;

const logger = createLogger('WorkspaceRootRegistry');

interface WorkspaceRootRegistryOptions {
  readonly createSecureRoot?: (rootPath: string) => Promise<SecureWorkspaceRoot>;
  readonly disposeCommandSessionsForRoot?: (rootId: string) => Promise<number>;
  readonly evictLspServersForRoot?: (rootId: string) => Promise<void>;
  readonly getRootsDatabase: () => Promise<WorkspaceRootsQueryable>;
  /**
   * Fired after a mount that IS recorded in the recents ledger
   * (`recordInRecentRoots` true — the picker path, and a recents-ledger-
   * matched picker-less mount). NOT fired for a managed-worktree mount
   * (BST-1390, spec §6.2): those are deliberately excluded from Recents, and
   * this is the SAME boolean that decision already uses, so the exclusion is
   * structural rather than something each caller has to remember (BST-1393
   * review finding).
   */
  readonly onRootGranted?: (grantedPath: string) => void;
  readonly pathExists: (rootPath: string) => Promise<boolean>;
  readonly resolveCanonicalRoot?: (rootPath: string) => Promise<string>;
  readonly resolveReadPath?: (requestedPath: string, canonicalRoot: string) => Promise<string>;
  readonly storage: ElectronStorageAdapter;
}

interface AddRootOptions {
  readonly recordInRecentRoots?: boolean;
}

export class WorkspaceRootRegistry {
  private readonly createSecureRoot: (rootPath: string) => Promise<SecureWorkspaceRoot>;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readonly disposeCommandSessionsForRoot: (rootId: string) => Promise<number>;
  private readonly evictLspServersForRoot: (rootId: string) => Promise<void>;
  private readonly getRootsDatabase: () => Promise<WorkspaceRootsQueryable>;
  private managedWorktreeAuthorizer: ManagedWorktreeAuthorizer | null = null;
  private readonly mounts = new WorkspaceRootMountTable();
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly retiringSourceRoots = new WeakSet<MountedWorkspaceRoot>();
  private readonly sourceLeases = new Set<{
    readonly lease: CanonicalWorkspaceLease;
    readonly mounted: MountedWorkspaceRoot;
  }>();
  private readonly onRootGranted: ((grantedPath: string) => void) | undefined;
  private readonly pathExists: (rootPath: string) => Promise<boolean>;
  private readonly resolveCanonicalRoot: (rootPath: string) => Promise<string>;
  private readonly resolveReadPath: (
    requestedPath: string,
    canonicalRoot: string
  ) => Promise<string>;
  private readonly storage: ElectronStorageAdapter;

  constructor(options: WorkspaceRootRegistryOptions) {
    this.createSecureRoot = options.createSecureRoot ?? createNativeSecureRoot;
    this.disposeCommandSessionsForRoot =
      options.disposeCommandSessionsForRoot ?? disposeDesktopCommandSessionsForRoot;
    this.evictLspServersForRoot = options.evictLspServersForRoot ?? evictLspServersForRoot;
    this.getRootsDatabase = options.getRootsDatabase;
    this.onRootGranted = options.onRootGranted;
    this.pathExists = options.pathExists;
    this.resolveCanonicalRoot = options.resolveCanonicalRoot ?? resolveCanonicalRootPath;
    this.resolveReadPath = options.resolveReadPath ?? resolveValidatedReadPath;
    this.storage = options.storage;
  }

  addRoot(
    handle: DirectoryHandle,
    { recordInRecentRoots = true }: AddRootOptions = {}
  ): Promise<RootDescriptor> {
    return this.serializeMutation(async () => {
      const presentationPath = path.normalize(handle.path);
      // Sequential, not Promise.all: addRoot already runs inside
      // serializeMutation (no concurrent caller to race against), and
      // sequencing means the try/finally below covers `probe` from the
      // instant it exists — a rejected readStoredRootsOrQuarantine() (a raw
      // storage I/O failure; corruption is quarantined rather than thrown)
      // can no longer leak an already-opened probe capability.
      const entries = await readStoredRootsOrQuarantine(this.storage);
      // Hoisted above the mount+persist mutation below (BST-1400 item 4): a
      // recentRootsList I/O failure must surface BEFORE anything is mounted
      // or persisted, not after — mirroring the rootsList read above. Before
      // this, `recordRecentRoot`'s own internal read ran AFTER
      // reconcileAddMount/persistAddedRoot had already succeeded, so a
      // broken ledger left addRoot() rejecting while the root was, in fact,
      // already mounted and persisted (state divergence). Positioned before
      // the mutation regardless; gated on `recordInRecentRoots` because that
      // flag is the only thing that can consume it (PR #2685 review: the
      // read itself IS conditional on this flag — only its POSITION, above
      // the mutation, is unconditional).
      //
      // The invariant throw below (`recentRootEntries === null`) sits AFTER
      // reconcileAddMount/persistAddedRoot, so tripping it would reintroduce
      // exactly the mount-succeeded-but-addRoot-rejected divergence this
      // hoist exists to remove. Acceptable for a genuinely unreachable
      // invariant (see that throw's own comment) — reading unconditionally
      // instead (dropping this ternary and the `null` case entirely) would
      // make the correlation a type-level fact rather than a runtime
      // assertion, at the cost of one extra storage read on the
      // managed-worktree path.
      const recentRootEntries = recordInRecentRoots
        ? await readRecentRootsOrQuarantine(this.storage)
        : null;
      // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- sequencing is the leak fix: the probe may only be opened once the store reads above have succeeded, so the try/finally owns it from the instant it exists.
      const probe = await this.createSecureRoot(presentationPath);
      let probeAdopted = false;
      try {
        // A dispose that lands while the probe was opening must fail this
        // call the same way mount() does, rather than returning a granted
        // descriptor for a registry that's already torn down.
        this.assertActive();
        const canonicalPath = path.normalize(probe.canonicalPath);
        const mountedMatch = this.mounts.findByCanonicalPath(canonicalPath);
        const existing = await this.findExistingStoredRoot(entries, mountedMatch, canonicalPath);

        const rootId = existing?.rootId ?? mountedMatch?.rootId ?? crypto.randomUUID();
        const entry: StoredWorkspaceRoot = {
          addedAt: Date.now(),
          path: existing?.path ?? presentationPath,
          rootId,
        };

        // reconcileAddMount always hands `probe` off to the mount table,
        // which unconditionally disposes of it (adopts it or closes it as
        // redundant) — so once this resolves, the probe has been handled
        // exactly once and the finally below must not touch it again.
        await this.reconcileAddMount(entry, mountedMatch, probe);
        probeAdopted = true;

        const persisted = await this.persistAddedRoot(entries, existing, entry);
        if (persisted) {
          await writeLastFolderBestEffort(this.storage, entry.path);
        }
        if (recordInRecentRoots) {
          // recentRootEntries is populated whenever recordInRecentRoots is
          // true (see the read above) — TypeScript just can't narrow that
          // correlation across the two separate checks. NO SILENT
          // FALLBACKS (review fold-in, BST-1400 item 4): a `?? []` here
          // would read as "the ledger is empty" and recordRecentRoot writes
          // `[newEntry, ...existing]` unconditionally, so if these two
          // conditions ever drifted, the fallback would silently overwrite
          // the user's entire recents ledger with a single entry. An
          // invariant violation must fail loud, the same as any other
          // ledger problem this function already surfaces before mutating.
          if (recentRootEntries === null) {
            throw new Error(
              'Invariant violated: recentRootEntries must be populated when recordInRecentRoots is true.'
            );
          }
          // The grant happened whether or not rootsList persistence succeeded,
          // so the ledger records it either way. Passes the entries read
          // above rather than letting recordRecentRoot re-read them — the
          // hoist's whole point is that this write can no longer fail on an
          // I/O problem the read above would already have surfaced.
          await recordRecentRoot(this.storage, entry.path, undefined, recentRootEntries);
          // Same gate as the ledger write above (BST-1393 review finding): a
          // managed-worktree mount passes recordInRecentRoots: false and must
          // not reach the OS recent-documents list either — the registry
          // already decided it doesn't belong in Recents.
          this.onRootGranted?.(entry.path);
        }
        return descriptorFor(entry, 'granted', persisted);
      } finally {
        if (!probeAdopted) {
          try {
            probe.close();
          } catch (error) {
            logger.warn('Failed to close a redundant workspace root probe', { error });
          }
        }
      }
    });
  }

  /**
   * Picker-less re-mount. TWO authorizations, both main-side: the recent-roots
   * ledger (a folder the user already granted) and the managed-worktree
   * authorizer (a directory this app created — spec §6.2). NOT wrapped in
   * serializeMutation — it delegates to addRoot, which serializes.
   */
  async addRootByPath(requestedPath: string): Promise<RootDescriptor> {
    const granted = await resolveGrantedRootHandle(
      this.storage,
      requestedPath,
      this.managedWorktreeAuthorizer ?? undefined
    );
    const descriptor = await this.addRoot(granted.handle, {
      recordInRecentRoots: granted.grantSource === 'recents',
    });
    if (granted.grantSource === 'managed-worktree') {
      logger.info('Mounted managed worktree without picker', {
        path: granted.handle.path,
        rootId: descriptor.rootId,
      });
    }
    return descriptor;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.disposal ??= Promise.all([this.mutationTail, this.retireSourceLeases()])
      .then(() => {
        this.mounts.closeAll();
      })
      .finally(() => {
        this.disposal = undefined;
      });
    return this.disposal;
  }

  async borrowSourceRoot(
    rootId: string,
    subscribe: SubscribeMountedWorkspaceRoot
  ): Promise<CanonicalWorkspaceLease> {
    if (!isDurableRootId(rootId)) {
      throw new Error('A mounted source borrow requires a durable rootId.');
    }
    await this.mutationTail;
    this.assertActive();
    const mounted = this.mounts.get(rootId);
    if (!mounted) {
      throw new Error('Canonical source rootId is not mounted.');
    }
    return this.borrowMountedSourceRoot(mounted, subscribe);
  }

  async borrowSourceRootForPath(
    requestedPath: string,
    subscribe: SubscribeMountedWorkspaceRoot
  ): Promise<CanonicalWorkspaceLease> {
    assertNativeAbsoluteReadPath(requestedPath, 'Watched root path');
    await this.mutationTail;
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
    if (this.mounts.get(rootId) !== mounted || this.retiringSourceRoots.has(mounted)) {
      throw new Error('Mounted source root changed during acquisition.');
    }
    const lease = createWorkspaceRootSourceLease({
      assertCurrent: () => {
        this.assertActive();
        if (this.mounts.get(rootId) !== mounted || this.retiringSourceRoots.has(mounted)) {
          throw new Error('Mounted source lease was revoked or replaced.');
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

  private async retireSourceLeases(mounted?: MountedWorkspaceRoot): Promise<void> {
    // Fence path borrows still resolving this exact mount before capturing its leases.
    // Failed retirement keeps admission closed until the owned cleanup is retried.
    if (mounted) {
      this.retiringSourceRoots.add(mounted);
    }
    const entries = [...this.sourceLeases].filter(
      (entry) => mounted === undefined || entry.mounted === mounted
    );
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        await entry.lease.retire();
        this.sourceLeases.delete(entry);
      })
    );
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

  /** Newest-first ledger of previously granted folders. */
  listRecentRoots(): Promise<readonly RecentRootEntry[]> {
    return this.serializeMutation(() => listRecentRootEntries(this.storage));
  }

  readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
    const diagnosticPath = projectReadDenialDiagnostic(handle.path);
    const diagnosticRootId =
      handle.rootId === undefined ? undefined : projectReadDenialDiagnostic(handle.rootId);
    return this.withReadDenialLogging('readDirectory', diagnosticPath, diagnosticRootId, () =>
      this.readDirectoryUnlogged(handle)
    );
  }

  private async readDirectoryUnlogged(handle: DirectoryHandle): Promise<IFileNode[]> {
    await this.mutationTail;
    this.assertActive();
    const resolved = await this.resolveRead(handle.path, handle.rootId);
    const listing = await resolved.mounted.root.listDir(
      resolved.relativePath,
      MAX_DIRECTORY_ENTRIES
    );
    if (!listing) {
      throw new AccessError('Directory is not accessible.', handle.path, 'read');
    }
    return buildDirectoryListing(resolved.mounted, handle.path, listing);
  }

  readFile(request: FileHandle | string): Promise<string> {
    const requestedPath = typeof request === 'string' ? request : request.path;
    const rootId = typeof request === 'string' ? undefined : request.rootId;
    const diagnosticPath = projectReadDenialDiagnostic(requestedPath);
    const diagnosticRootId = rootId === undefined ? undefined : projectReadDenialDiagnostic(rootId);
    return this.withReadDenialLogging('readFile', diagnosticPath, diagnosticRootId, () =>
      this.readFileUnlogged(requestedPath, rootId)
    );
  }

  readFileByAbsolutePath(
    requestedPath: unknown,
    claimedRootPath: unknown,
    claimedRootId: unknown
  ): Promise<string> {
    const diagnosticPath = projectReadDenialDiagnostic(requestedPath);
    return this.withReadDenialLogging('readFileByAbsolutePath', diagnosticPath, undefined, () => {
      assertNativeAbsoluteReadPath(claimedRootPath, 'Claimed workspace root path');
      assertNativeAbsoluteReadPath(requestedPath, 'Requested file path');
      if (!isDurableRootId(claimedRootId)) {
        throw new AccessError(
          'Claimed workspace root identity must be a durable rootId.',
          diagnosticPath,
          'read'
        );
      }
      return this.readFileByAbsolutePathUnlogged(requestedPath, claimedRootPath, claimedRootId);
    });
  }

  private async readFileByAbsolutePathUnlogged(
    requestedPath: string,
    claimedRootPath: string,
    claimedRootId: string
  ): Promise<string> {
    await this.mutationTail;
    this.assertActive();
    const mounted = this.mounts.get(claimedRootId);
    if (!mounted) {
      throw new AccessError('Claimed workspace rootId is not mounted.', requestedPath, 'read');
    }
    if (
      !(
        pathsEqual(mounted.presentationPath, claimedRootPath) ||
        pathsEqual(mounted.canonicalPath, claimedRootPath)
      )
    ) {
      throw new AccessError(
        'Claimed workspace root path does not match the mounted workspace rootId.',
        requestedPath,
        'read'
      );
    }
    const resolved = await resolveReadAgainstMountedRoot(
      requestedPath,
      mounted,
      this.resolveReadPath
    );
    return readResolvedWorkspaceFile(requestedPath, resolved);
  }

  private async readFileUnlogged(
    requestedPath: string,
    rootId: string | undefined
  ): Promise<string> {
    await this.mutationTail;
    this.assertActive();
    const resolved = await this.resolveRead(requestedPath, rootId);
    return readResolvedWorkspaceFile(requestedPath, resolved);
  }

  removeRoot(rootId: string): Promise<void> {
    return this.serializeMutation(async () => {
      const entries = await readStoredRootsOrQuarantine(this.storage);
      const removed = entries.find((entry) => entry.rootId === rootId);
      const mounted = this.mounts.get(rootId);
      if (mounted) {
        await this.retireSourceLeases(mounted);
      }
      if (!removed) {
        // Unconditional, not session-gated: a quarantined read returns an
        // empty entries list even for a persisted (non-session) root, so
        // this branch must retire any live mount for rootId regardless of
        // session/persisted status — retireMount is already a no-op for an
        // id that isn't mounted. convergeDatabase then demotes the
        // now-unmounted path in the DB and evicts DB-id-keyed resources,
        // since retireMount alone cleans up only under the adapter rootId.
        await this.retireMount(rootId);
        await this.convergeDatabase();
        return;
      }

      const remaining = entries.filter((entry) => entry.rootId !== rootId);
      await writeStoredRoots(this.storage, remaining);
      let disconnected: readonly { id: string; path: string }[];
      try {
        const db = await this.getRootsDatabase();
        disconnected = await markRootsDisconnectedExcept(
          db,
          this.mounts.persistedMountedPaths(rootId)
        );
      } catch (error) {
        try {
          await writeStoredRoots(this.storage, entries);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Workspace disconnect failed and its persisted-root rollback also failed.'
          );
        }
        throw error;
      }

      await this.unmountSourceRoot(rootId);
      await this.cleanupRootResources(disconnected.map((row) => row.id));
      await clearLastFolderIfMatches(this.storage, removed.path);
    });
  }

  restoreLastFolder(): Promise<DirectoryHandle | null> {
    return this.serializeMutation(async () => {
      const lastFolder = await readLastFolder(this.storage);
      if (!lastFolder) {
        return null;
      }
      const mounted = this.mounts.findByPresentationPath(lastFolder);
      if (!mounted) {
        return null;
      }
      return descriptorFor(
        {
          addedAt: 0,
          path: mounted.presentationPath,
          rootId: mounted.rootId,
        },
        'granted'
      ).handle;
    });
  }

  restoreRoots(): Promise<RootDescriptor[]> {
    return this.serializeMutation(async () => {
      const entries = await readStoredRoots(this.storage);
      const descriptors: RootDescriptor[] = [];
      const retainedRootIds = this.mounts.sessionMountIds();
      const retainedCanonicalPaths = new Set<string>();
      const storedSurvivors: StoredWorkspaceRoot[] = [];
      const recentRootCandidates: StoredWorkspaceRoot[] = [];

      for (const entry of entries) {
        // eslint-disable-next-line react-doctor/async-await-in-loop -- mounts are intentionally serial: each iteration's canonical-alias dedup and session-supersession bookkeeping depends on the mounts installed by prior iterations.
        const mountResult = await this.tryMountStoredEntry(entry);
        if (!mountResult.ok) {
          descriptors.push(descriptorFor(entry, 'unknown'));
          storedSurvivors.push(entry);
          continue;
        }
        const { canonicalPath } = mountResult;
        if (retainedCanonicalPaths.has(pathKey(canonicalPath))) {
          logger.warn('Discarding a duplicate persisted alias for the same workspace root', {
            rootId: entry.rootId,
          });
          await this.unmountSourceRoot(entry.rootId);
          continue;
        }
        // A session mint of the same canonical path is superseded by the
        // persisted identity.
        await this.supersedeSessionMountsFor(entry, canonicalPath, retainedRootIds);
        retainedCanonicalPaths.add(pathKey(canonicalPath));
        retainedRootIds.add(entry.rootId);
        storedSurvivors.push(entry);
        recentRootCandidates.push(entry);
        descriptors.push(descriptorFor(entry, 'granted'));
      }

      for (const mountedRootId of this.mounts.ids()) {
        if (!retainedRootIds.has(mountedRootId)) {
          await this.unmountSourceRoot(mountedRootId);
        }
      }
      if (storedSurvivors.length !== entries.length) {
        await writeStoredRoots(this.storage, storedSurvivors);
      }
      const kindByRootId = await this.loadPersistedRootKinds(recentRootCandidates);
      // BST-1400 item 4: one shared read + at most one shared write for the
      // whole restored batch, instead of up to two ledger reads PER restored
      // root (recordRecentRootIfNew's own read plus recordRecentRoot's).
      const newRecentCandidates = recentRootCandidates.flatMap((entry) =>
        kindByRootId.get(entry.rootId) === 'worktree'
          ? []
          : [{ lastGrantedAt: entry.addedAt, path: entry.path }]
      );
      await recordRecentRootsIfNew(this.storage, newRecentCandidates);
      await this.convergeDatabase();
      return descriptors;
    });
  }

  private async loadPersistedRootKinds(
    entries: readonly StoredWorkspaceRoot[]
  ): Promise<ReadonlyMap<string, string | null>> {
    const kindByRootId = new Map<string, string | null>();
    if (entries.length === 0) {
      return kindByRootId;
    }
    try {
      const db = await this.getRootsDatabase();
      const kindRows = await db.query<{ id: string; kind: string | null }>(
        'SELECT id, kind FROM roots WHERE id = ANY($1::text[])',
        [entries.map((entry) => entry.rootId)]
      );
      for (const row of kindRows.rows) {
        kindByRootId.set(row.id, row.kind);
      }
    } catch (error) {
      logger.warn('Could not read persisted workspace root kinds; restoring Recents as before', {
        error,
      });
    }
    return kindByRootId;
  }

  setLastFolder(folderPath: string): Promise<void> {
    return this.serializeMutation(async () => {
      const mounted = this.mounts.findByEitherPath(path.normalize(folderPath));
      if (!(mounted && !this.mounts.isSessionMount(mounted.rootId))) {
        throw new Error('The last-folder preference must reference a persisted mounted root.');
      }
      await writeLastFolder(this.storage, mounted.presentationPath);
    });
  }

  /**
   * Install the managed-worktree gate (spec §6.2). `null` removes it, which
   * returns `addRootByPath` to recents-only.
   */
  setManagedWorktreeAuthorizer(authorizer: ManagedWorktreeAuthorizer | null): void {
    this.managedWorktreeAuthorizer = authorizer;
  }

  private async cleanupRootResources(rootIds: readonly string[]): Promise<void> {
    await Promise.all(
      rootIds.map(async (rootId) => {
        await Promise.all([
          this.evictLspServersForRoot(rootId).catch((error: unknown) => {
            logger.warn('Workspace root LSP cleanup failed', { error, rootId });
          }),
          this.disposeCommandSessionsForRoot(rootId).catch((error: unknown) => {
            logger.warn('Workspace root command-session cleanup failed', { error, rootId });
          }),
        ]);
      })
    );
  }

  private async convergeDatabase(): Promise<void> {
    const mountedPaths = this.mounts.persistedMountedPaths();
    try {
      const db = await this.getRootsDatabase();
      const disconnected = await markRootsDisconnectedExcept(db, mountedPaths);
      await this.cleanupRootResources(disconnected.map((row) => row.id));
    } catch (error) {
      logger.error('Workspace root database convergence failed', { error });
    }
  }

  private async findExistingStoredRoot(
    entries: readonly StoredWorkspaceRoot[],
    mountedMatch: MountedWorkspaceRoot | undefined,
    canonicalPath: string
  ): Promise<StoredWorkspaceRoot | undefined> {
    // The mounted match's own persisted entry (if any) always wins over an
    // incidental canonicalization match on some other stored alias — order
    // in `entries` must never decide which stored root a live mount owns.
    if (mountedMatch) {
      const owned = entries.find((candidate) => candidate.rootId === mountedMatch.rootId);
      if (owned) {
        return owned;
      }
    }
    for (const candidate of entries) {
      if (this.mounts.has(candidate.rootId)) {
        continue;
      }
      try {
        if (pathsEqual(await this.resolveCanonicalRoot(candidate.path), canonicalPath)) {
          return candidate;
        }
      } catch (error) {
        logger.warn('Could not canonicalize a stored root while adding a folder', {
          error,
          rootId: candidate.rootId,
        });
      }
    }
    return;
  }

  /**
   * Retires a mount as the single, uniform teardown path: unmount its
   * capability and evict every resource keyed on its rootId (LSP servers,
   * command sessions) — the same cleanup every other retirement path
   * (removeRoot, convergeDatabase) already performs.
   */
  private async retireMount(rootId: string): Promise<void> {
    this.mounts.clearSessionMount(rootId);
    await this.unmountSourceRoot(rootId);
    await this.cleanupRootResources([rootId]);
  }

  /**
   * Reconciles the newly-opened probe capability against any existing mount
   * for this root's canonical path, then hands it to the mount table, which
   * unconditionally disposes of it — either adopting it as the live
   * capability or closing it as redundant against an identical incumbent.
   * Callers must not close `probe` again after this resolves.
   */
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
    return this.mounts.install(entry, root);
  }

  private async persistAddedRoot(
    entries: readonly StoredWorkspaceRoot[],
    existing: StoredWorkspaceRoot | undefined,
    entry: StoredWorkspaceRoot
  ): Promise<boolean> {
    const nextEntries = existing
      ? entries.map((candidate) => (candidate.rootId === existing.rootId ? entry : candidate))
      : [...entries, entry];
    try {
      await writeStoredRoots(this.storage, nextEntries);
      this.mounts.clearSessionMount(entry.rootId);
      return true;
    } catch (error) {
      if (existing) {
        logger.warn('Failed to refresh an already-persisted workspace root', {
          error,
          rootId: entry.rootId,
        });
        return true;
      }
      this.mounts.markSessionMount(entry.rootId);
      logger.warn('Workspace root is mounted for this session but could not be persisted', {
        error,
        rootId: entry.rootId,
      });
      return false;
    }
  }

  private async mount(entry: StoredWorkspaceRoot): Promise<string> {
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
      return await this.installSourceRoot(entry, secureRoot);
    } catch (error) {
      secureRoot.close();
      throw error;
    }
  }

  private async tryMountStoredEntry(
    entry: StoredWorkspaceRoot
  ): Promise<{ canonicalPath: string; ok: true } | { ok: false }> {
    try {
      if (!(await this.pathExists(entry.path))) {
        logger.warn('Workspace root is unavailable and will remain persisted for retry', {
          rootId: entry.rootId,
        });
        return { ok: false };
      }
      const canonicalPath = await this.mount(entry);
      return { canonicalPath, ok: true };
    } catch (error) {
      logger.error('Workspace root mount failed and remains persisted for retry', {
        error,
        rootId: entry.rootId,
      });
      return { ok: false };
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

  /**
   * Durably logs every read denial at warn before rethrowing (BST-1257): the
   * BST-1255 indexer halt threw AccessErrors that crossed IPC into a renderer
   * banner and left ZERO trace in main's logs. Wraps the ENTIRE public read
   * operation (review on #2433), so post-resolution denials — inaccessible
   * directory, oversized/unreadable/symlink file results — are covered, not
   * just path validation. Routine not-found probes (tab restoration, stale
   * handles) stay quiet: the IPC layer converts those to a normal payload.
   */
  private async withReadDenialLogging<T>(
    operation: 'readDirectory' | 'readFile' | 'readFileByAbsolutePath',
    requestedPath: string,
    rootId: string | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AccessError && !isFileNotFoundError(error)) {
        const diagnosticError = projectReadDenialError(error);
        logger.warn('Workspace read denied', {
          ...diagnosticError,
          operation,
          requestedPath,
          rootId: rootId ?? null,
        });
      }
      throw error;
    }
  }

  private async resolveRead(
    requestedPath: string,
    rootId?: string
  ): Promise<ResolvedWorkspaceRead> {
    if (requestedPath.includes('\0')) {
      throw new AccessError('Requested path contains null bytes.', requestedPath, 'read');
    }
    if (rootId === undefined && !path.isAbsolute(requestedPath)) {
      throw new AccessError(
        'Relative workspace reads require a durable rootId.',
        requestedPath,
        'read'
      );
    }
    const mounted = this.mounts.resolveForRead(requestedPath, rootId);
    if (!mounted) {
      throw new AccessError(
        rootId ? 'Workspace root is not mounted.' : 'Path is outside every mounted workspace root.',
        requestedPath,
        'read'
      );
    }
    return resolveReadAgainstMountedRoot(requestedPath, mounted, this.resolveReadPath);
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      this.assertActive();
      return operation();
    };
    const result = this.mutationTail.then(execute, execute);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('The workspace root registry has been disposed.');
    }
  }
}
