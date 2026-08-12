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
import { fileNodeCollator } from '@brainstrike/utils';

const MAX_DIRECTORY_ENTRIES = 10_000;

export interface SecureWorkspaceRoot {
  close(): void;
  listDir(
    relativePath: string,
    maxEntries: number
  ): Promise<{
    readonly entries: readonly {
      readonly isDirectory: boolean;
      readonly isFile: boolean;
      readonly lastModified?: number;
      readonly name: string;
      readonly size?: number;
    }[];
    readonly inspected: number;
    readonly truncated: boolean;
  } | null>;
  readFile(
    relativePath: string,
    maxBytes: number
  ): Promise<
    | { readonly content: Buffer; readonly status: 'ok' }
    | { readonly status: 'oversized' | 'unreadable' }
  >;
}

interface MountedRoot {
  readonly canonicalPath: string;
  readonly root: SecureWorkspaceRoot;
  readonly rootId: string;
}

export interface WorkspaceRootIdentity {
  readonly path: string;
  readonly rootId: string;
}

export interface WorkspaceFileCapabilityOptions {
  readonly createSecureRoot?: (
    canonicalRoot: string
  ) => Promise<SecureWorkspaceRoot> | SecureWorkspaceRoot;
  readonly resolveCanonicalPath?: (requestedPath: string, rootPath?: string) => Promise<string>;
}

export interface WorkspaceFileReadOptions {
  readonly rootId?: string;
}

function isContained(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === '' ||
    !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  );
}

async function defaultResolveCanonicalPath(
  requestedPath: string,
  rootPath?: string
): Promise<string> {
  const result = await resolveValidatedPath({
    allowMissing: false,
    blockSensitiveDirectories: true,
    maxTraversal: 0,
    requestedPath,
    ...(rootPath === undefined ? {} : { rootDir: rootPath }),
  });
  if (!result.ok) {
    throw new AccessError(`Path validation failed: ${result.error.message}`, requestedPath, 'read');
  }
  return path.normalize(result.path);
}

function buildDirectoryNode(
  mounted: MountedRoot,
  parentPath: string,
  entry: {
    readonly isDirectory: boolean;
    readonly lastModified?: number;
    readonly name: string;
    readonly size?: number;
  }
): IFileNode {
  const entryPath = path.join(parentPath, entry.name);
  if (entry.isDirectory) {
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

export interface WorkspaceFileCapabilities {
  dispose(): void;
  getMountedRoot?(rootId: string): WorkspaceRootIdentity | undefined;
  mountRoot(identity: WorkspaceRootIdentity): Promise<string>;
  readDirectory(handle: DirectoryHandle): Promise<IFileNode[]>;
  readFile(request: FileHandle | string, options?: WorkspaceFileReadOptions): Promise<string>;
  retainRoots(rootIds: ReadonlySet<string>): void;
  unmountRoot(rootId: string): void;
}

export function createWorkspaceFileCapabilities(
  options: WorkspaceFileCapabilityOptions = {}
): WorkspaceFileCapabilities {
  const createSecureRoot =
    options.createSecureRoot ??
    (async (rootPath: string): Promise<SecureWorkspaceRoot> => {
      const { SecureRoot } = await import('@brainstrike/secure-fs-native');
      const root = new SecureRoot(rootPath);
      return {
        close: () => root.close(),
        listDir: (relativePath, maxEntries) => root.listDirAsync(relativePath, maxEntries),
        readFile: (relativePath, maxBytes) => root.readFileAsync(relativePath, maxBytes),
      };
    });
  const resolveCanonicalPath = options.resolveCanonicalPath ?? defaultResolveCanonicalPath;
  const mountedRoots = new Map<string, MountedRoot>();

  function unmountRoot(rootId: string): void {
    const mounted = mountedRoots.get(rootId);
    if (!mounted) {
      return;
    }
    mountedRoots.delete(rootId);
    mounted.root.close();
  }

  async function mountRoot(identity: WorkspaceRootIdentity): Promise<string> {
    if (identity.rootId.trim().length === 0) {
      throw new AccessError('Workspace rootId must be a non-empty string.', identity.path, 'read');
    }
    const canonicalPath = await resolveCanonicalPath(identity.path);
    const root = await createSecureRoot(canonicalPath);
    unmountRoot(identity.rootId);
    mountedRoots.set(identity.rootId, { canonicalPath, root, rootId: identity.rootId });
    return canonicalPath;
  }

  function chooseMountedRoot(requestedPath: string, rootId?: string): MountedRoot {
    if (rootId !== undefined) {
      const mounted = mountedRoots.get(rootId);
      if (!mounted) {
        throw new AccessError('Workspace root is not mounted.', requestedPath, 'read');
      }
      return mounted;
    }
    if (!path.isAbsolute(requestedPath)) {
      throw new AccessError(
        'Relative workspace reads require a durable rootId.',
        requestedPath,
        'read'
      );
    }
    const candidate = path.normalize(requestedPath);
    const matches = [...mountedRoots.values()].filter((mounted) =>
      isContained(mounted.canonicalPath, candidate)
    );
    matches.sort((left, right) => right.canonicalPath.length - left.canonicalPath.length);
    const mounted = matches[0];
    if (!mounted) {
      throw new AccessError('Path is outside every mounted workspace root.', requestedPath, 'read');
    }
    return mounted;
  }

  async function resolveRead(
    requestedPath: string,
    rootId?: string
  ): Promise<{ mounted: MountedRoot; relativePath: string; requestedAbsolutePath: string }> {
    const mounted = chooseMountedRoot(requestedPath, rootId);
    const requestedAbsolutePath = path.isAbsolute(requestedPath)
      ? path.normalize(requestedPath)
      : path.resolve(mounted.canonicalPath, requestedPath);
    if (!isContained(mounted.canonicalPath, requestedAbsolutePath)) {
      throw new AccessError(
        'Path is outside the selected workspace root.',
        requestedAbsolutePath,
        'read'
      );
    }
    // Canonicalization enforces containment and sensitive-path policy. The
    // descriptor-relative native operation remains the authority for rejecting
    // every symlink/reparse component without a check-then-open race.
    await resolveCanonicalPath(requestedAbsolutePath, mounted.canonicalPath);
    return {
      mounted,
      relativePath: path.relative(mounted.canonicalPath, requestedAbsolutePath) || '.',
      requestedAbsolutePath,
    };
  }

  return {
    dispose: () => {
      for (const mounted of mountedRoots.values()) {
        mounted.root.close();
      }
      mountedRoots.clear();
    },
    getMountedRoot: (rootId) => {
      const mounted = mountedRoots.get(rootId);
      return mounted ? { path: mounted.canonicalPath, rootId: mounted.rootId } : undefined;
    },
    mountRoot,
    readDirectory: async (handle) => {
      const { mounted, relativePath, requestedAbsolutePath } = await resolveRead(
        handle.path,
        handle.rootId
      );
      const listing = await mounted.root.listDir(relativePath, MAX_DIRECTORY_ENTRIES);
      if (!listing) {
        throw new AccessError('Directory is not accessible.', requestedAbsolutePath, 'read');
      }
      if (listing.truncated) {
        throw new AccessError(
          `Directory exceeds the ${MAX_DIRECTORY_ENTRIES}-entry safety limit.`,
          requestedAbsolutePath,
          'read'
        );
      }
      const nodes: IFileNode[] = [];
      for (const entry of listing.entries) {
        if (entry.isDirectory || entry.isFile) {
          nodes.push(buildDirectoryNode(mounted, requestedAbsolutePath, entry));
        }
      }
      return nodes.sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === 'directory' ? -1 : 1;
        }
        return fileNodeCollator.compare(left.name, right.name);
      });
    },
    readFile: async (request, readOptions = {}) => {
      const requestedPath = typeof request === 'string' ? request : request.path;
      const rootId = typeof request === 'string' ? readOptions.rootId : request.rootId;
      const { maxFileSize } = getFileSizeConfig();
      const { mounted, relativePath, requestedAbsolutePath } = await resolveRead(
        requestedPath,
        rootId
      );
      const result = await mounted.root.readFile(relativePath, maxFileSize);
      if (result.status !== 'ok') {
        if (result.status === 'oversized') {
          throw new AccessError(
            `File too large (max: ${formatFileSize(maxFileSize)})`,
            requestedAbsolutePath,
            'read'
          );
        }
        throw new AccessError('File is not accessible.', requestedAbsolutePath, 'read');
      }
      return result.content.toString('utf8');
    },
    retainRoots: (rootIds) => {
      for (const rootId of mountedRoots.keys()) {
        if (!rootIds.has(rootId)) {
          unmountRoot(rootId);
        }
      }
    },
    unmountRoot,
  };
}
