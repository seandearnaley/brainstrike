import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  AccessError,
  type DirectoryHandle,
  type FileHandle,
  formatFileSize,
  getFileSizeConfig,
  type IFileNode,
} from '@brainstrike/file-system';
import { resolveValidatedPath } from '@brainstrike/file-system/path-validation';
import { createLogger } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { RootDescriptor } from '@brainstrike/types';
import { fileNodeCollator } from '@brainstrike/utils';
import { disposeDesktopCommandSessionsForRoot } from '../assistant-server/command-session-manager';
import { evictLspServersForRoot } from '../assistant-server/lsp-diagnostics';
import {
  markRootsDisconnectedExcept,
  type WorkspaceRootsQueryable,
} from '../assistant-server/workspace-roots';

const CORRUPT_ROOTS_LIST_STORAGE_KEY = 'rootsList.corrupt' as const;
const LAST_FOLDER_STORAGE_KEY = 'lastFolderPath' as const;
const MAX_DIRECTORY_ENTRIES = 10_000;
/**
 * The native secure-fs read path (SecureRoot.readFileAsync) caps a single
 * read at 16MB regardless of the configured maxFileSize. A configured value
 * above this cap would silently degrade every oversized read to
 * `status: 'unreadable'` — indistinguishable from a real access failure — so
 * readFile fails loud at the configuration boundary instead.
 */
const NATIVE_MAX_READ_BYTES = 16 * 1024 * 1024;
const ROOTS_LIST_STORAGE_KEY = 'rootsList' as const;
const logger = createLogger('WorkspaceRootRegistry');

interface SecureWorkspaceDirEntry {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly lastModified?: number;
  readonly name: string;
  readonly size?: number;
}

export interface SecureWorkspaceRoot {
  readonly canonicalPath: string;
  close(): void;
  listDir(
    relativePath: string,
    maxEntries: number
  ): Promise<{
    readonly entries: readonly SecureWorkspaceDirEntry[];
    readonly inspected: number;
    readonly truncated: boolean;
  } | null>;
  readFile(
    relativePath: string,
    maxBytes: number
  ): Promise<
    | { readonly content: Buffer; readonly status: 'ok' }
    | { readonly status: 'not-found' | 'oversized' | 'unreadable' }
  >;
}

export interface StoredWorkspaceRoot {
  readonly addedAt: number;
  readonly path: string;
  readonly rootId: string;
}

interface MountedWorkspaceRoot {
  readonly canonicalPath: string;
  readonly presentationPath: string;
  readonly root: SecureWorkspaceRoot;
  readonly rootId: string;
}

interface WorkspaceRootRegistryOptions {
  readonly createSecureRoot?: (rootPath: string) => Promise<SecureWorkspaceRoot>;
  readonly disposeCommandSessionsForRoot?: (rootId: string) => Promise<number>;
  readonly evictLspServersForRoot?: (rootId: string) => Promise<void>;
  readonly getRootsDatabase: () => Promise<WorkspaceRootsQueryable>;
  readonly pathExists: (rootPath: string) => Promise<boolean>;
  readonly resolveCanonicalRoot?: (rootPath: string) => Promise<string>;
  readonly resolveReadPath?: (requestedPath: string, canonicalRoot: string) => Promise<string>;
  readonly storage: ElectronStorageAdapter;
}

function isStoredWorkspaceRoot(value: unknown): value is StoredWorkspaceRoot {
  if (!(value && typeof value === 'object')) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['addedAt'] === 'number' &&
    Number.isFinite(candidate['addedAt']) &&
    typeof candidate['path'] === 'string' &&
    candidate['path'].length > 0 &&
    typeof candidate['rootId'] === 'string' &&
    candidate['rootId'].length > 0
  );
}

/**
 * Pure validation, deliberately separated from storage I/O: it throws only
 * when `raw` itself is corrupt (bad JSON, wrong shape, duplicate root IDs),
 * never for an I/O failure — callers that need to tell those two apart (see
 * readStoredRootsOrQuarantine) read the raw value once themselves and pass
 * it here, rather than letting a storage exception get relabeled as
 * "corrupt".
 */
function parseStoredRoots(raw: string | null): StoredWorkspaceRoot[] {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('The persisted workspace root registry is not valid JSON.', {
      cause: error,
    });
  }
  if (!(Array.isArray(parsed) && parsed.every(isStoredWorkspaceRoot))) {
    throw new Error('The persisted workspace root registry has an invalid shape.');
  }
  const ids = new Set(parsed.map((entry) => entry.rootId));
  if (ids.size !== parsed.length) {
    throw new Error('The persisted workspace root registry contains duplicate root IDs.');
  }
  return parsed;
}

function isContained(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === '' ||
    !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  );
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function resolveLexicalRelativePath(mounted: MountedWorkspaceRoot, requestedPath: string): string {
  if (path.isAbsolute(requestedPath)) {
    const normalized = path.normalize(requestedPath);
    if (isContained(mounted.presentationPath, normalized)) {
      return path.relative(mounted.presentationPath, normalized);
    }
    if (isContained(mounted.canonicalPath, normalized)) {
      return path.relative(mounted.canonicalPath, normalized);
    }
  } else {
    const lexicalTarget = path.resolve(mounted.canonicalPath, requestedPath);
    if (isContained(mounted.canonicalPath, lexicalTarget)) {
      return path.relative(mounted.canonicalPath, lexicalTarget);
    }
  }
  throw new AccessError('Path is outside the selected workspace root.', requestedPath, 'read');
}

function descriptorFor(
  entry: StoredWorkspaceRoot,
  permissionState: 'granted' | 'unknown',
  persisted = true
): RootDescriptor {
  const displayName = path.basename(entry.path) || entry.path;
  return {
    displayName,
    handle: {
      kind: 'directory',
      name: displayName,
      path: entry.path,
      platform: 'electron',
      rootId: entry.rootId,
    },
    kind: 'path',
    permissionState,
    persisted,
    rootId: entry.rootId,
  };
}

function buildDirectoryNode(
  mounted: MountedWorkspaceRoot,
  parentPath: string,
  entry: SecureWorkspaceDirEntry
): IFileNode {
  const entryPath = path.join(parentPath, entry.name);
  const isDirectory = entry.isDirectory && !entry.isSymbolicLink;
  if (isDirectory) {
    return {
      children: [],
      depth: 0,
      handle: {
        kind: 'directory',
        name: entry.name,
        path: entryPath,
        platform: 'electron',
        rootId: mounted.rootId,
      } as unknown as FileSystemDirectoryHandle,
      ...(entry.isSymbolicLink ? { isSymbolicLink: true } : {}),
      isVisible: true,
      name: entry.name,
      path: entryPath,
      rootFolderId: mounted.rootId,
      selectionState: 'unchecked',
      type: 'directory',
    };
  }
  return {
    depth: 0,
    handle: {
      kind: 'file',
      name: entry.name,
      path: entryPath,
      platform: 'electron',
      rootId: mounted.rootId,
    } as unknown as FileSystemFileHandle,
    ...(entry.isSymbolicLink ? { isSymbolicLink: true } : {}),
    isVisible: true,
    ...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
    name: entry.name,
    path: entryPath,
    rootFolderId: mounted.rootId,
    selectionState: 'unchecked',
    ...(entry.size === undefined ? {} : { size: entry.size }),
    type: 'file',
  };
}

const TRUNCATION_NODE_BASENAME = '…truncated…' as const;

function buildTruncationNode(
  mounted: MountedWorkspaceRoot,
  parentPath: string,
  inspected: number
): IFileNode {
  const entryPath = path.join(parentPath, TRUNCATION_NODE_BASENAME);
  return {
    depth: 0,
    handle: {
      kind: 'file',
      name: TRUNCATION_NODE_BASENAME,
      path: entryPath,
      platform: 'electron',
      rootId: mounted.rootId,
    } as unknown as FileSystemFileHandle,
    isVisible: true,
    name: `Showing first ${inspected.toLocaleString('en-US')} entries`,
    path: entryPath,
    rootFolderId: mounted.rootId,
    selectionState: 'unchecked',
    type: 'truncated',
  };
}

export class WorkspaceRootRegistry {
  private readonly createSecureRoot: (rootPath: string) => Promise<SecureWorkspaceRoot>;
  private disposed = false;
  private readonly disposeCommandSessionsForRoot: (rootId: string) => Promise<number>;
  private readonly evictLspServersForRoot: (rootId: string) => Promise<void>;
  private readonly getRootsDatabase: () => Promise<WorkspaceRootsQueryable>;
  private readonly mounted = new Map<string, MountedWorkspaceRoot>();
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly pathExists: (rootPath: string) => Promise<boolean>;
  private readonly resolveCanonicalRoot: (rootPath: string) => Promise<string>;
  private readonly resolveReadPath: (
    requestedPath: string,
    canonicalRoot: string
  ) => Promise<string>;
  private readonly sessionRootIds = new Set<string>();
  private readonly storage: ElectronStorageAdapter;

  constructor(options: WorkspaceRootRegistryOptions) {
    this.createSecureRoot =
      options.createSecureRoot ??
      (async (rootPath): Promise<SecureWorkspaceRoot> => {
        const { SecureRoot } = await import('@brainstrike/secure-fs-native');
        const root = new SecureRoot(rootPath);
        return {
          canonicalPath: root.canonicalPath,
          close: () => root.close(),
          listDir: (relativePath, maxEntries) => root.listDirAsync(relativePath, maxEntries),
          readFile: (relativePath, maxBytes) => root.readFileAsync(relativePath, maxBytes),
        };
      });
    this.disposeCommandSessionsForRoot =
      options.disposeCommandSessionsForRoot ?? disposeDesktopCommandSessionsForRoot;
    this.evictLspServersForRoot = options.evictLspServersForRoot ?? evictLspServersForRoot;
    this.getRootsDatabase = options.getRootsDatabase;
    this.pathExists = options.pathExists;
    this.resolveCanonicalRoot =
      options.resolveCanonicalRoot ??
      (async (rootPath) => path.normalize(await realpath(rootPath)));
    this.resolveReadPath =
      options.resolveReadPath ??
      (async (requestedPath, canonicalRoot) => {
        const result = await resolveValidatedPath({
          allowMissing: false,
          blockSensitiveDirectories: true,
          maxTraversal: 0,
          requestedPath,
          rootDir: canonicalRoot,
        });
        if (!result.ok) {
          throw new AccessError(
            `Path validation failed: ${result.error.message}`,
            requestedPath,
            'read'
          );
        }
        return path.normalize(result.path);
      });
    this.storage = options.storage;
  }

  addRoot(handle: DirectoryHandle): Promise<RootDescriptor> {
    return this.serializeMutation(async () => {
      const presentationPath = path.normalize(handle.path);
      // Sequential, not Promise.all: addRoot already runs inside
      // serializeMutation (no concurrent caller to race against), and
      // sequencing means the try/finally below covers `probe` from the
      // instant it exists — a rejected readStoredRootsOrQuarantine() (a raw
      // storage I/O failure; corruption is quarantined rather than thrown)
      // can no longer leak an already-opened probe capability.
      const entries = await this.readStoredRootsOrQuarantine();
      // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- sequencing is the leak fix: the probe may only be opened once the store read has succeeded, so the try/finally owns it from the instant it exists.
      const probe = await this.createSecureRoot(presentationPath);
      let probeAdopted = false;
      try {
        // A dispose that lands while the probe was opening must fail this
        // call the same way mount() does, rather than returning a granted
        // descriptor for a registry that's already torn down.
        this.assertActive();
        const canonicalPath = path.normalize(probe.canonicalPath);
        const mountedMatch = [...this.mounted.values()].find((candidate) =>
          pathsEqual(candidate.canonicalPath, canonicalPath)
        );
        const existing = await this.findExistingStoredRoot(entries, mountedMatch, canonicalPath);

        const rootId = existing?.rootId ?? mountedMatch?.rootId ?? crypto.randomUUID();
        const entry: StoredWorkspaceRoot = {
          addedAt: Date.now(),
          path: existing?.path ?? presentationPath,
          rootId,
        };

        // reconcileAddMount always hands `probe` off to installMount, which
        // unconditionally disposes of it (adopts it or closes it as
        // redundant) — so once this resolves, the probe has been handled
        // exactly once and the finally below must not touch it again.
        await this.reconcileAddMount(entry, mountedMatch, probe);
        probeAdopted = true;

        const persisted = await this.persistAddedRoot(entries, existing, entry);
        if (persisted) {
          await this.storage
            .setItem(LAST_FOLDER_STORAGE_KEY, entry.path)
            .catch((error: unknown) => {
              logger.warn('Failed to update the last-folder presentation preference', { error });
            });
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

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    void this.mutationTail.finally(() => {
      for (const mounted of this.mounted.values()) {
        this.closeMountedRoot(mounted);
      }
      this.mounted.clear();
      this.sessionRootIds.clear();
    });
  }

  async readDirectory(handle: DirectoryHandle): Promise<IFileNode[]> {
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
    const nodes = listing.entries
      .map((entry) => buildDirectoryNode(resolved.mounted, handle.path, entry))
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === 'directory' ? -1 : 1;
        }
        return fileNodeCollator.compare(left.name, right.name);
      });
    if (listing.truncated) {
      // Partial result, surfaced: the native bound held, the caller sees it.
      nodes.push(buildTruncationNode(resolved.mounted, handle.path, listing.inspected));
    }
    return nodes;
  }

  async readFile(request: FileHandle | string): Promise<string> {
    await this.mutationTail;
    this.assertActive();
    const requestedPath = typeof request === 'string' ? request : request.path;
    const rootId = typeof request === 'string' ? undefined : request.rootId;
    const resolved = await this.resolveRead(requestedPath, rootId);
    const { maxFileSize } = getFileSizeConfig();
    if (maxFileSize > NATIVE_MAX_READ_BYTES) {
      throw new AccessError(
        `Configured maxFileSize (${formatFileSize(maxFileSize)}) exceeds the native secure-read cap (${formatFileSize(NATIVE_MAX_READ_BYTES)}).`,
        requestedPath,
        'read'
      );
    }
    const result = await resolved.mounted.root.readFile(resolved.relativePath, maxFileSize);
    if (result.status === 'ok') {
      return result.content.toString('utf8');
    }
    if (result.status === 'oversized') {
      throw new AccessError(
        `File too large (max: ${formatFileSize(maxFileSize)})`,
        requestedPath,
        'read'
      );
    }
    if (result.status === 'not-found') {
      throw new AccessError('ENOENT: File not found', requestedPath, 'read');
    }
    if (resolved.traversedSymlink) {
      throw new AccessError(
        'File is a symbolic link. Links are not followed inside workspace roots.',
        requestedPath,
        'read'
      );
    }
    throw new AccessError('File is not accessible.', requestedPath, 'read');
  }

  removeRoot(rootId: string): Promise<void> {
    return this.serializeMutation(async () => {
      const entries = await this.readStoredRootsOrQuarantine();
      const removed = entries.find((entry) => entry.rootId === rootId);
      if (!removed) {
        // Unconditional, not sessionRootIds-gated: a quarantined read
        // returns an empty entries list even for a persisted (non-session)
        // root, so this branch must retire any live mount for rootId
        // regardless of session/persisted status — retireMount is already a
        // no-op for an id that isn't mounted. convergeDatabase then demotes
        // the now-unmounted path in the DB and evicts DB-id-keyed resources,
        // since retireMount alone cleans up only under the adapter rootId.
        await this.retireMount(rootId);
        await this.convergeDatabase();
        return;
      }

      const remaining = entries.filter((entry) => entry.rootId !== rootId);
      await this.writeStoredRoots(remaining);
      let disconnected: readonly { id: string; path: string }[];
      try {
        const db = await this.getRootsDatabase();
        const mountedPaths: string[] = [];
        for (const mounted of this.mounted.values()) {
          if (mounted.rootId !== rootId && !this.sessionRootIds.has(mounted.rootId)) {
            mountedPaths.push(mounted.presentationPath);
          }
        }
        disconnected = await markRootsDisconnectedExcept(db, mountedPaths);
      } catch (error) {
        try {
          await this.writeStoredRoots(entries);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Workspace disconnect failed and its persisted-root rollback also failed.'
          );
        }
        throw error;
      }

      this.unmount(rootId);
      await this.cleanupRootResources(disconnected.map((row) => row.id));
      await this.clearLastFolderIfRemoved(removed);
    });
  }

  restoreLastFolder(): Promise<DirectoryHandle | null> {
    return this.serializeMutation(async () => {
      const lastFolder = await this.storage.getItem(LAST_FOLDER_STORAGE_KEY);
      if (!lastFolder) {
        return null;
      }
      const mounted = [...this.mounted.values()].find((candidate) =>
        pathsEqual(candidate.presentationPath, lastFolder)
      );
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
      const entries = await this.readStoredRoots();
      const descriptors: RootDescriptor[] = [];
      const retainedRootIds = new Set(this.sessionRootIds);
      const retainedCanonicalPaths = new Set<string>();
      const storedSurvivors: StoredWorkspaceRoot[] = [];

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
          this.unmount(entry.rootId);
          continue;
        }
        // A session mint of the same canonical path is superseded by the
        // persisted identity.
        await this.supersedeSessionMountsFor(entry, canonicalPath, retainedRootIds);
        retainedCanonicalPaths.add(pathKey(canonicalPath));
        retainedRootIds.add(entry.rootId);
        storedSurvivors.push(entry);
        descriptors.push(descriptorFor(entry, 'granted'));
      }

      for (const rootId of [...this.mounted.keys()]) {
        if (!retainedRootIds.has(rootId)) {
          this.unmount(rootId);
        }
      }
      if (storedSurvivors.length !== entries.length) {
        await this.writeStoredRoots(storedSurvivors);
      }
      await this.convergeDatabase();
      return descriptors;
    });
  }

  setLastFolder(folderPath: string): Promise<void> {
    return this.serializeMutation(async () => {
      const normalized = path.normalize(folderPath);
      const mounted = [...this.mounted.values()].find(
        (candidate) =>
          pathsEqual(candidate.presentationPath, normalized) ||
          pathsEqual(candidate.canonicalPath, normalized)
      );
      if (!(mounted && !this.sessionRootIds.has(mounted.rootId))) {
        throw new Error('The last-folder preference must reference a persisted mounted root.');
      }
      await this.storage.setItem(LAST_FOLDER_STORAGE_KEY, mounted.presentationPath);
    });
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
    const mountedPaths: string[] = [];
    for (const mounted of this.mounted.values()) {
      if (!this.sessionRootIds.has(mounted.rootId)) {
        mountedPaths.push(mounted.presentationPath);
      }
    }
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
      if (this.mounted.has(candidate.rootId)) {
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
    this.sessionRootIds.delete(rootId);
    this.unmount(rootId);
    await this.cleanupRootResources([rootId]);
  }

  /**
   * Reconciles the newly-opened probe capability against any existing mount
   * for this root's canonical path, then hands it to installMount, which
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
    this.installMount(entry, probe);
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
      await this.writeStoredRoots(nextEntries);
      this.sessionRootIds.delete(entry.rootId);
      return true;
    } catch (error) {
      if (existing) {
        logger.warn('Failed to refresh an already-persisted workspace root', {
          error,
          rootId: entry.rootId,
        });
        return true;
      }
      this.sessionRootIds.add(entry.rootId);
      logger.warn('Workspace root is mounted for this session but could not be persisted', {
        error,
        rootId: entry.rootId,
      });
      return false;
    }
  }

  private installMount(entry: StoredWorkspaceRoot, secureRoot: SecureWorkspaceRoot): string {
    const canonicalPath = path.normalize(secureRoot.canonicalPath);
    const presentationPath = path.normalize(entry.path);
    const current = this.mounted.get(entry.rootId);
    if (
      current &&
      pathsEqual(current.canonicalPath, canonicalPath) &&
      pathsEqual(current.presentationPath, presentationPath)
    ) {
      // Post-open incumbent check (not the deleted pre-claim check —
      // identity still comes from the opened probe's own canonicalPath):
      // the incumbent capability already serves this exact identity, so
      // keep it live — its open readers/handles stay valid — and discard
      // the redundant, freshly-opened probe instead of severing them.
      // Guarded on object identity: if the caller handed us the SAME
      // capability object as the incumbent, it is not redundant — closing
      // it would sever the live mount.
      if (secureRoot !== current.root) {
        try {
          secureRoot.close();
        } catch (error) {
          logger.warn('Failed to close a redundant workspace root capability', { error });
        }
      }
      return canonicalPath;
    }
    this.mounted.set(entry.rootId, {
      canonicalPath,
      presentationPath,
      root: secureRoot,
      rootId: entry.rootId,
    });
    if (current && current.root !== secureRoot) {
      this.closeMountedRoot(current);
    }
    return canonicalPath;
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
    return this.installMount(entry, secureRoot);
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
    for (const candidate of [...this.mounted.values()]) {
      if (
        candidate.rootId !== entry.rootId &&
        this.sessionRootIds.has(candidate.rootId) &&
        pathsEqual(candidate.canonicalPath, canonicalPath)
      ) {
        retainedRootIds.delete(candidate.rootId);
        // eslint-disable-next-line react-doctor/async-await-in-loop -- retirement is intentionally serial: capability close must precede resource cleanup, and the mounted map is mutated while iterating a snapshot.
        await this.retireMount(candidate.rootId);
      }
    }
  }

  private async clearLastFolderIfRemoved(removed: StoredWorkspaceRoot): Promise<void> {
    try {
      const lastFolder = await this.storage.getItem(LAST_FOLDER_STORAGE_KEY);
      if (lastFolder && pathsEqual(lastFolder, removed.path)) {
        await this.storage.removeItem(LAST_FOLDER_STORAGE_KEY);
      }
    } catch (error) {
      logger.warn('Failed to clear the last-folder presentation preference', { error });
    }
  }

  private closeMountedRoot(mounted: MountedWorkspaceRoot): void {
    try {
      mounted.root.close();
    } catch (error) {
      logger.warn('Failed to close a workspace root capability', {
        error,
        rootId: mounted.rootId,
      });
    }
  }

  private async readStoredRoots(): Promise<StoredWorkspaceRoot[]> {
    return parseStoredRoots(await this.storage.getItem(ROOTS_LIST_STORAGE_KEY));
  }

  /**
   * Mutation-path reader: a corrupt store must not brick add/remove, but it is
   * never coerced — the raw value is preserved for diagnosis and the failure
   * is logged at error level. Convergence paths (restoreRoots) intentionally
   * keep the throwing readStoredRoots: an unknown mount set is never an
   * authoritative zero.
   *
   * The raw value is read exactly once. An I/O failure from that single read
   * propagates uncaught (fail loud) rather than being mistaken for
   * corruption; only a validation failure from parseStoredRoots — thrown on
   * that same already-read `raw` — triggers quarantine, and the bytes
   * quarantined are provably the exact bytes that failed to parse.
   */
  private async readStoredRootsOrQuarantine(): Promise<StoredWorkspaceRoot[]> {
    const raw = await this.storage.getItem(ROOTS_LIST_STORAGE_KEY);
    try {
      return parseStoredRoots(raw);
    } catch (error) {
      if (raw !== null) {
        await this.storage.setItem(CORRUPT_ROOTS_LIST_STORAGE_KEY, raw);
        await this.storage.removeItem(ROOTS_LIST_STORAGE_KEY);
      }
      logger.error('Quarantined a corrupt workspace root registry value', {
        error,
        quarantineKey: CORRUPT_ROOTS_LIST_STORAGE_KEY,
      });
      return [];
    }
  }

  private async resolveRead(
    requestedPath: string,
    rootId?: string
  ): Promise<{
    mounted: MountedWorkspaceRoot;
    relativePath: string;
    traversedSymlink: boolean;
  }> {
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
    const mounted = this.resolveMountedRoot(requestedPath, rootId);
    if (!mounted) {
      throw new AccessError(
        rootId ? 'Workspace root is not mounted.' : 'Path is outside every mounted workspace root.',
        requestedPath,
        'read'
      );
    }
    const lexicalRelativePath = resolveLexicalRelativePath(mounted, requestedPath);

    // Realpath is an authorization preflight only. The native operation keeps
    // the lexical relative path so an in-root symlink cannot be rewritten to
    // its target and accidentally become readable.
    const canonicalTarget = await this.resolveReadPath(requestedPath, mounted.canonicalPath);
    if (!isContained(mounted.canonicalPath, canonicalTarget)) {
      throw new AccessError('Path is outside the selected workspace root.', requestedPath, 'read');
    }
    // A symlink was traversed or is the leaf itself when the realpath
    // preflight resolved somewhere other than the purely lexical target —
    // the native read below never follows it (see comment above), so this
    // is reported to the caller as a precise, non-generic error instead.
    const lexicalAbsoluteTarget = path.normalize(
      path.join(mounted.canonicalPath, lexicalRelativePath)
    );
    const traversedSymlink = !pathsEqual(lexicalAbsoluteTarget, canonicalTarget);
    return {
      mounted,
      relativePath: lexicalRelativePath || '.',
      traversedSymlink,
    };
  }

  /**
   * Resolves the mounted root for a read, given an optional caller-supplied
   * rootId. A stale/wrong rootId (e.g. held across a remount) still resolves
   * when `requestedPath` is itself absolute: it falls back to the same
   * path-anchored lookup the no-rootId path already uses
   * (findMountedRootForAbsolutePath). This is NOT a security downgrade — the
   * fallback still goes through the identical containment check and realpath
   * preflight below; only the requested rootId's authority is treated as
   * fungible with "an absolute path that resolves into some mounted root",
   * never a relaxation of what paths are readable. A relative path with an
   * unknown rootId has no other anchor and keeps throwing.
   */
  private resolveMountedRoot(
    requestedPath: string,
    rootId: string | undefined
  ): MountedWorkspaceRoot | undefined {
    if (rootId === undefined) {
      return this.findMountedRootForAbsolutePath(requestedPath);
    }
    const mounted = this.mounted.get(rootId);
    if (mounted) {
      return mounted;
    }
    if (path.isAbsolute(requestedPath)) {
      return this.findMountedRootForAbsolutePath(requestedPath);
    }
    return;
  }

  private findMountedRootForAbsolutePath(requestedPath: string): MountedWorkspaceRoot | undefined {
    const normalized = path.normalize(requestedPath);
    return [...this.mounted.values()]
      .filter(
        (candidate) =>
          isContained(candidate.presentationPath, normalized) ||
          isContained(candidate.canonicalPath, normalized)
      )
      .sort(
        (left, right) =>
          Math.max(right.presentationPath.length, right.canonicalPath.length) -
          Math.max(left.presentationPath.length, left.canonicalPath.length)
      )[0];
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

  private unmount(rootId: string): void {
    const mounted = this.mounted.get(rootId);
    if (!mounted) {
      return;
    }
    this.mounted.delete(rootId);
    this.closeMountedRoot(mounted);
  }

  private async writeStoredRoots(entries: readonly StoredWorkspaceRoot[]): Promise<void> {
    await this.storage.setItem(ROOTS_LIST_STORAGE_KEY, JSON.stringify(entries));
  }
}
