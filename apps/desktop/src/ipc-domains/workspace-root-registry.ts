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

const LAST_FOLDER_STORAGE_KEY = 'lastFolderPath' as const;
const MAX_DIRECTORY_ENTRIES = 10_000;
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
      const canonicalPath = await this.resolveCanonicalRoot(presentationPath);
      const entries = await this.readStoredRoots();
      let existing: StoredWorkspaceRoot | undefined;
      for (const entry of entries) {
        try {
          const entryCanonical =
            this.mounted.get(entry.rootId)?.canonicalPath ??
            (await this.resolveCanonicalRoot(entry.path));
          if (pathsEqual(entryCanonical, canonicalPath)) {
            existing = entry;
            break;
          }
        } catch (error) {
          logger.warn('Could not canonicalize a stored root while adding a folder', {
            error,
            rootId: entry.rootId,
          });
        }
      }

      const entry: StoredWorkspaceRoot = {
        addedAt: Date.now(),
        path: existing?.path ?? presentationPath,
        rootId: existing?.rootId ?? crypto.randomUUID(),
      };
      await this.mount(entry, canonicalPath);

      let persisted = true;
      const nextEntries = existing
        ? entries.map((candidate) => (candidate.rootId === existing.rootId ? entry : candidate))
        : [...entries, entry];
      try {
        await this.writeStoredRoots(nextEntries);
        this.sessionRootIds.delete(entry.rootId);
      } catch (error) {
        if (existing) {
          logger.warn('Failed to refresh an already-persisted workspace root', {
            error,
            rootId: entry.rootId,
          });
        } else {
          persisted = false;
          this.sessionRootIds.add(entry.rootId);
          logger.warn('Workspace root is mounted for this session but could not be persisted', {
            error,
            rootId: entry.rootId,
          });
        }
      }

      if (persisted) {
        await this.storage.setItem(LAST_FOLDER_STORAGE_KEY, entry.path).catch((error: unknown) => {
          logger.warn('Failed to update the last-folder presentation preference', { error });
        });
      }
      return descriptorFor(entry, 'granted', persisted);
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
    if (listing.truncated) {
      throw new AccessError(
        `Directory exceeds the ${MAX_DIRECTORY_ENTRIES}-entry safety limit.`,
        handle.path,
        'read'
      );
    }
    return listing.entries
      .map((entry) => buildDirectoryNode(resolved.mounted, handle.path, entry))
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === 'directory' ? -1 : 1;
        }
        return fileNodeCollator.compare(left.name, right.name);
      });
  }

  async readFile(request: FileHandle | string): Promise<string> {
    await this.mutationTail;
    this.assertActive();
    const requestedPath = typeof request === 'string' ? request : request.path;
    const rootId = typeof request === 'string' ? undefined : request.rootId;
    const resolved = await this.resolveRead(requestedPath, rootId);
    const { maxFileSize } = getFileSizeConfig();
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
    throw new AccessError('File is not accessible.', requestedPath, 'read');
  }

  removeRoot(rootId: string): Promise<void> {
    return this.serializeMutation(async () => {
      const entries = await this.readStoredRoots();
      const removed = entries.find((entry) => entry.rootId === rootId);
      if (!removed) {
        if (this.sessionRootIds.delete(rootId)) {
          this.unmount(rootId);
        }
        return;
      }

      const remaining = entries.filter((entry) => entry.rootId !== rootId);
      await this.writeStoredRoots(remaining);
      let disconnected: readonly { id: string; path: string }[];
      try {
        const db = await this.getRootsDatabase();
        const mountedPaths = [...this.mounted.values()]
          .filter(
            (mounted) => mounted.rootId !== rootId && !this.sessionRootIds.has(mounted.rootId)
          )
          .map((mounted) => mounted.presentationPath);
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
        let canonicalPath: string;
        try {
          if (!(await this.pathExists(entry.path))) {
            logger.warn('Workspace root is unavailable and will remain persisted for retry', {
              rootId: entry.rootId,
            });
            descriptors.push(descriptorFor(entry, 'unknown'));
            storedSurvivors.push(entry);
            continue;
          }
          canonicalPath = await this.resolveCanonicalRoot(entry.path);
          if (retainedCanonicalPaths.has(pathKey(canonicalPath))) {
            logger.warn('Discarding a duplicate persisted alias for the same workspace root', {
              rootId: entry.rootId,
            });
            continue;
          }
          await this.mount(entry, canonicalPath);
        } catch (error) {
          logger.error('Workspace root mount failed and remains persisted for retry', {
            error,
            rootId: entry.rootId,
          });
          descriptors.push(descriptorFor(entry, 'unknown'));
          storedSurvivors.push(entry);
          continue;
        }
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
    const mountedPaths = [...this.mounted.values()]
      .filter((mounted) => !this.sessionRootIds.has(mounted.rootId))
      .map((mounted) => mounted.presentationPath);
    try {
      const db = await this.getRootsDatabase();
      const disconnected = await markRootsDisconnectedExcept(db, mountedPaths);
      await this.cleanupRootResources(disconnected.map((row) => row.id));
    } catch (error) {
      logger.error('Workspace root database convergence failed', { error });
    }
  }

  private async mount(entry: StoredWorkspaceRoot, canonicalPath: string): Promise<void> {
    this.assertActive();
    const current = this.mounted.get(entry.rootId);
    if (
      current &&
      pathsEqual(current.canonicalPath, canonicalPath) &&
      pathsEqual(current.presentationPath, entry.path)
    ) {
      return;
    }
    const secureRoot = await this.createSecureRoot(canonicalPath);
    if (this.disposed) {
      try {
        secureRoot.close();
      } catch (error) {
        logger.warn('Failed to close a workspace root capability during disposal', { error });
      }
      this.assertActive();
    }
    if (!pathsEqual(secureRoot.canonicalPath, canonicalPath)) {
      try {
        secureRoot.close();
      } catch (error) {
        logger.warn('Failed to close a rejected workspace root capability', { error });
      }
      throw new AccessError(
        'Workspace root changed while its filesystem capability was being mounted.',
        entry.path,
        'read'
      );
    }
    const mounted: MountedWorkspaceRoot = {
      canonicalPath: path.normalize(secureRoot.canonicalPath),
      presentationPath: path.normalize(entry.path),
      root: secureRoot,
      rootId: entry.rootId,
    };
    this.mounted.set(entry.rootId, mounted);
    if (current) {
      this.closeMountedRoot(current);
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
    const raw = await this.storage.getItem(ROOTS_LIST_STORAGE_KEY);
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

  private async resolveRead(
    requestedPath: string,
    rootId?: string
  ): Promise<{ mounted: MountedWorkspaceRoot; relativePath: string }> {
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
    const mounted = rootId
      ? this.mounted.get(rootId)
      : this.findMountedRootForAbsolutePath(requestedPath);
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
    return {
      mounted,
      relativePath: lexicalRelativePath || '.',
    };
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
