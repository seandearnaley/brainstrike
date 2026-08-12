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
import { SecureRoot } from '@brainstrike/secure-fs-native';
import { fileNodeCollator } from '@brainstrike/utils';

const MAX_DIRECTORY_ENTRIES = 10_000;

export interface SecureWorkspaceRoot {
  close(): void;
  listDir(
    relativePath: string,
    maxEntries: number
  ): {
    readonly entries: readonly {
      readonly isDirectory: boolean;
      readonly isFile: boolean;
      readonly name: string;
    }[];
    readonly inspected: number;
    readonly truncated: boolean;
  } | null;
  readFile(
    relativePath: string,
    maxBytes: number
  ):
    | { readonly content: Buffer; readonly status: 'ok' }
    | { readonly status: 'oversized' | 'unreadable' };
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
  readonly createSecureRoot?: (canonicalRoot: string) => SecureWorkspaceRoot;
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

function pathsEqual(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
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
  entry: { readonly isDirectory: boolean; readonly name: string }
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
    name: entry.name,
    path: entryPath,
    rootFolderId: mounted.rootId,
    selectionState: 'unchecked',
    type: 'file',
  };
}

export interface WorkspaceFileCapabilities {
  dispose(): void;
  mountRoot(identity: WorkspaceRootIdentity): Promise<string>;
  readDirectory(handle: DirectoryHandle): Promise<IFileNode[]>;
  readFile(request: FileHandle | string, options?: WorkspaceFileReadOptions): Promise<string>;
  retainRoots(rootIds: ReadonlySet<string>): void;
  unmountRoot(rootId: string): void;
}

export function createWorkspaceFileCapabilities(
  options: WorkspaceFileCapabilityOptions = {}
): WorkspaceFileCapabilities {
  const createSecureRoot = options.createSecureRoot ?? ((rootPath) => new SecureRoot(rootPath));
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
    const root = createSecureRoot(canonicalPath);
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
    const canonicalTarget = await resolveCanonicalPath(
      requestedAbsolutePath,
      mounted.canonicalPath
    );
    if (!pathsEqual(canonicalTarget, requestedAbsolutePath)) {
      throw new AccessError(
        'Symbolic links and reparse points are not supported inside workspace roots.',
        requestedAbsolutePath,
        'read'
      );
    }
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
    mountRoot,
    readDirectory: async (handle) => {
      const { mounted, relativePath, requestedAbsolutePath } = await resolveRead(
        handle.path,
        handle.rootId
      );
      const listing = mounted.root.listDir(relativePath, MAX_DIRECTORY_ENTRIES);
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
      return listing.entries
        .filter((entry) => entry.isDirectory || entry.isFile)
        .map((entry) => buildDirectoryNode(mounted, requestedAbsolutePath, entry))
        .sort((left, right) => {
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
      const result = mounted.root.readFile(relativePath, maxFileSize);
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
