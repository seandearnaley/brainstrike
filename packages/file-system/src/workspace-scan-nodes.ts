import { createLogger } from '@brainstrike/logging';
import type { DirectoryHandle, FileSystemChange, IFileNode } from '@brainstrike/types';
import type { createBackgroundIndexingEntryPolicy } from '@brainstrike/utils/background-indexing-policy';
import type { FileSystemAdapter } from './types.js';
import {
  countRelativePathSegments,
  getParentRelativePath,
  getPathName,
  isRootSelfPath,
  iterRelativePathSegments,
  normalizeScopedChangePath,
  toRootAnchoredPath,
  toRootRelativePath,
} from './workspace-scan-paths.js';

export interface WorkspaceDiscoveryDeps {
  fileSystemAdapter: Pick<FileSystemAdapter, 'readDirectory' | 'resolveFileHandleByPath'>;
}
export interface ScopedPendingRemoval {
  change: FileSystemChange;
  relativePath: string;
}
export interface ScopedChangeAccumulator {
  changedFileNodesByPath: Map<string, IFileNode>;
  forceReadRelativePaths: Set<string>;
  pendingRemovals: ScopedPendingRemoval[];
}
type WorkspaceIndexingEntryPolicy = ReturnType<typeof createBackgroundIndexingEntryPolicy>;
const logger = createLogger('WorkspaceCollectionSyncScan');

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  const error = new Error('Workspace collection sync was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function isDirectoryNode(node: IFileNode): boolean {
  return node.type === 'directory';
}

function isFileNode(node: IFileNode): boolean {
  return node.type === 'file';
}

function toDirectoryHandle(node: IFileNode, rootHandle: DirectoryHandle): DirectoryHandle {
  const nodeHandle = 'platform' in node.handle ? node.handle : null;
  const rootId = nodeHandle?.rootId ?? rootHandle.rootId;
  return {
    // On web, the child node's handle IS the raw FileSystemDirectoryHandle
    // (no _internal on it) and must become the rebuilt handle's _internal —
    // the web adapter can only read directories through it.
    _internal: nodeHandle?._internal ?? node.handle,
    kind: 'directory',
    name: node.name,
    path: node.path,
    platform: nodeHandle?.platform ?? rootHandle.platform,
    ...(rootId === undefined ? {} : { rootId }),
  };
}

function toSyntheticFileNode(args: {
  relativePath: string;
  rootHandle: DirectoryHandle;
  rootPath: string;
}): IFileNode {
  // Anchor rather than join: the web watcher's paths are already root-anchored,
  // and re-joining them doubles the root segment (see toRootAnchoredPath).
  const absolutePath = toRootAnchoredPath(args.rootPath, args.relativePath);
  const fileName = getPathName(args.relativePath);
  return {
    // Watcher batches can synthesize many file nodes; scan once instead of
    // allocating split/filter arrays for every changed path. Depth is measured
    // from the root, so it counts the root-relative path, not the cache identity.
    depth: countRelativePathSegments(toRootRelativePath(args.rootPath, absolutePath)),
    handle: {
      kind: 'file',
      name: fileName,
      path: absolutePath,
      platform: args.rootHandle.platform,
    },
    name: fileName,
    path: absolutePath,
    rootFolderId: args.rootPath,
    selectionState: 'unchecked',
    type: 'file',
  };
}

/**
 * A synthetic descriptor handle is unreadable on web: file content processing
 * stamps `node.handle` as the FileHandle's `_internal`, and the web adapter's
 * readFile requires that to be a raw FileSystemFileHandle. When the sibling
 * listing missed a changed file (truncated listing, or created after the
 * parent was listed), resolve the real child handle through the adapter's
 * capability seam — absent on adapters that read by path (Electron), which
 * keep the synthetic node. A failed resolution also keeps the synthetic node:
 * the doomed read surfaces the path in `inaccessiblePaths` instead of the
 * change silently vanishing from the scan.
 */
async function resolveSyntheticFileNodeHandle(args: {
  deps: WorkspaceDiscoveryDeps;
  node: IFileNode;
  onResolutionFailure: (path: string) => void;
  rootHandle: DirectoryHandle;
}): Promise<IFileNode> {
  const { fileSystemAdapter } = args.deps;
  if (!fileSystemAdapter.resolveFileHandleByPath) {
    return args.node;
  }
  // The durable rootId is the ONLY thing that names the root being scanned.
  // Two weaker forms were tried and are wrong: the node's own path is prefixed
  // with the root's display NAME, which the adapter never matches against its
  // id-keyed handle cache; and a bare root-relative path is resolved against
  // `lastRootFolderId` — the last root ADDED — so scanning any other root
  // silently returns that root's copy of the same relative path and indexes
  // its bytes here. Without a rootId there is no safe query to make.
  const { rootId } = args.rootHandle;
  if (!rootId) {
    args.onResolutionFailure(args.node.path);
    return args.node;
  }
  try {
    // The adapter walks from the root handle, so it needs the path relative to
    // the ROOT — not the managed-cache identity, which on web still carries the
    // root-name prefix and would send it into a phantom child of the root.
    const rawFileHandle = await fileSystemAdapter.resolveFileHandleByPath(
      `${rootId}/${toRootRelativePath(args.rootHandle.path, args.node.path)}`
    );
    // Mirror the web adapter's readDirectory shape: node.handle IS the raw handle.
    return { ...args.node, handle: rawFileHandle };
  } catch (error) {
    args.onResolutionFailure(args.node.path);
    logger.debug('Workspace Index could not resolve a web file handle for a changed path', {
      error: error instanceof Error ? error.message : String(error),
      path: args.node.path,
    });
    return args.node;
  }
}

/**
 * A failed resolution leaves an unreadable synthetic node, so the file lands in
 * `inaccessiblePaths` rather than being indexed. A single miss is an ordinary
 * race (deleted between the watcher event and the scan) and stays at debug; a
 * batch of them means something systemic — root handle evicted, permission
 * revoked — which would otherwise repeat invisibly on every scan forever. One
 * warning per scan, mirroring `warnOnTruncatedDirectories`.
 */
async function readDirectoryWithProgress(args: {
  abortSignal: AbortSignal;
  deps: WorkspaceDiscoveryDeps;
  handle: DirectoryHandle;
  onDirectoryTruncated: (path: string) => void;
  statusReporter: { report: (path: string | null) => void };
}): Promise<IFileNode[]> {
  throwIfAborted(args.abortSignal);
  args.statusReporter.report(args.handle.path);
  const nodes = await args.deps.fileSystemAdapter.readDirectory(args.handle, {
    includeMetadata: true,
  });
  if (!Array.isArray(nodes)) {
    throw new Error(
      `File system adapter returned an invalid directory listing: ${args.handle.path}`
    );
  }
  // Mirror the walker contract: report truncation, and never let the marker
  // pseudo-node reach scoped consumers (a future consumer treating "not a
  // directory" as "file" would otherwise index a phantom entry).
  if (nodes.some((node) => node.type === 'truncated')) {
    args.onDirectoryTruncated(args.handle.path);
    throwIfAborted(args.abortSignal);
    return nodes.filter((node) => node.type !== 'truncated');
  }
  throwIfAborted(args.abortSignal);
  return nodes;
}

async function resolveDirectoryHandleForRelativePath(args: {
  abortSignal: AbortSignal;
  deps: WorkspaceDiscoveryDeps;
  entryPolicy: WorkspaceIndexingEntryPolicy;
  onDirectoryTruncated: (path: string) => void;
  onExcludedEntry: () => void;
  relativePath: string;
  rootHandle: DirectoryHandle;
  rootPath: string;
  statusReporter: { report: (path: string | null) => void };
}): Promise<DirectoryHandle | null> {
  let currentHandle = args.rootHandle;
  let currentRelativePath = '';
  // Walking descends from the ROOT HANDLE, so it is expressed in root-relative
  // coordinates — not the managed-cache identity, which on web still carries
  // the root-name prefix and would send the first step looking for a child of
  // the root named after the root itself. The entry policy takes the same
  // coordinate by contract (see background-indexing-policy.ts).
  for (const segment of iterRelativePathSegments(
    toRootRelativePath(args.rootPath, toRootAnchoredPath(args.rootPath, args.relativePath))
  )) {
    const children = await readDirectoryWithProgress({
      abortSignal: args.abortSignal,
      deps: args.deps,
      handle: currentHandle,
      onDirectoryTruncated: args.onDirectoryTruncated,
      statusReporter: args.statusReporter,
    });
    const nextRelativePath = currentRelativePath ? `${currentRelativePath}/${segment}` : segment;
    const matchingDirectory = children.find((node) => {
      if (!isDirectoryNode(node)) {
        return false;
      }
      if (node.name === segment) {
        return true;
      }
      return toRootRelativePath(args.rootPath, node.path) === nextRelativePath;
    });
    if (!matchingDirectory) {
      return null;
    }
    if (
      !args.entryPolicy.shouldTraverseDirectory({
        directoryName: matchingDirectory.name,
        relativePath: nextRelativePath,
      })
    ) {
      args.onExcludedEntry();
      return null;
    }
    currentHandle = toDirectoryHandle(matchingDirectory, args.rootHandle);
    currentRelativePath = nextRelativePath;
  }
  return currentHandle;
}

async function resolveChangedFileNode(args: {
  abortSignal: AbortSignal;
  deps: WorkspaceDiscoveryDeps;
  entryPolicy: WorkspaceIndexingEntryPolicy;
  onDirectoryTruncated: (path: string) => void;
  onExcludedEntry: () => void;
  onFileHandleResolutionFailure: (path: string) => void;
  relativePath: string;
  rootHandle: DirectoryHandle;
  rootPath: string;
  statusReporter: { report: (path: string | null) => void };
}): Promise<IFileNode | null> {
  // Root-relative is the coordinate for walking and for the entry policy; the
  // managed-cache identity (args.relativePath) stays the DB key and is not
  // interchangeable with it on web.
  const nodePath = toRootAnchoredPath(args.rootPath, args.relativePath);
  const rootRelativePath = toRootRelativePath(args.rootPath, nodePath);
  const parentRelativePath = getParentRelativePath(rootRelativePath);
  const parentHandle = parentRelativePath
    ? await resolveDirectoryHandleForRelativePath({
        abortSignal: args.abortSignal,
        deps: args.deps,
        entryPolicy: args.entryPolicy,
        onDirectoryTruncated: args.onDirectoryTruncated,
        onExcludedEntry: args.onExcludedEntry,
        relativePath: parentRelativePath,
        rootHandle: args.rootHandle,
        rootPath: args.rootPath,
        statusReporter: args.statusReporter,
      })
    : args.rootHandle;
  const fileName = getPathName(args.relativePath);
  const syntheticNode = toSyntheticFileNode({
    relativePath: args.relativePath,
    rootHandle: args.rootHandle,
    rootPath: args.rootPath,
  });
  let node = syntheticNode;
  if (parentHandle) {
    const siblings = await readDirectoryWithProgress({
      abortSignal: args.abortSignal,
      deps: args.deps,
      handle: parentHandle,
      onDirectoryTruncated: args.onDirectoryTruncated,
      statusReporter: args.statusReporter,
    });
    const matchingNode = siblings.find(
      (candidate) =>
        isFileNode(candidate) &&
        candidate.name === fileName &&
        toRootRelativePath(args.rootPath, candidate.path) === rootRelativePath
    );
    if (matchingNode) {
      node = matchingNode;
    }
  }
  if (
    !args.entryPolicy.shouldIncludeFile({
      fileName: node.name,
      fileSize: node.size ?? 0,
      relativePath: rootRelativePath,
    })
  ) {
    args.onExcludedEntry();
    return null;
  }
  // Resolve only what survives the gate: on web this costs a getDirectoryHandle
  // per path segment plus a best-effort handle-cache write, and a watcher burst
  // (installs, builds) is overwhelmingly paths the gate drops. Ordering is
  // safe because resolution cannot change the gate's inputs — a raw
  // FileSystemFileHandle carries neither the name nor the size it reads.
  if (node === syntheticNode) {
    node = await resolveSyntheticFileNodeHandle({
      deps: args.deps,
      node,
      onResolutionFailure: args.onFileHandleResolutionFailure,
      rootHandle: args.rootHandle,
    });
  }
  return node;
}

async function readScopedDirectoryTree(args: {
  abortSignal: AbortSignal;
  deps: WorkspaceDiscoveryDeps;
  directoryHandle: DirectoryHandle;
  entryPolicy: WorkspaceIndexingEntryPolicy;
  onDirectoryTruncated: (path: string) => void;
  onExcludedEntry: () => void;
  rootHandle: DirectoryHandle;
  rootPath: string;
  statusReporter: { report: (path: string | null) => void };
}): Promise<IFileNode[]> {
  const children = await readDirectoryWithProgress({
    abortSignal: args.abortSignal,
    deps: args.deps,
    handle: args.directoryHandle,
    onDirectoryTruncated: args.onDirectoryTruncated,
    statusReporter: args.statusReporter,
  });
  const fileNodes: IFileNode[] = [];
  for (const node of children) {
    // Entry-policy coordinate: relative to the ROOT, per its documented
    // contract — not the managed-cache identity.
    const relativePath = toRootRelativePath(args.rootPath, node.path);
    if (isDirectoryNode(node)) {
      if (
        !args.entryPolicy.shouldTraverseDirectory({
          directoryName: node.name,
          relativePath,
        })
      ) {
        args.onExcludedEntry();
        continue;
      }
      fileNodes.push(
        ...(await readScopedDirectoryTree({
          abortSignal: args.abortSignal,
          deps: args.deps,
          directoryHandle: toDirectoryHandle(node, args.rootHandle),
          entryPolicy: args.entryPolicy,
          onDirectoryTruncated: args.onDirectoryTruncated,
          onExcludedEntry: args.onExcludedEntry,
          rootHandle: args.rootHandle,
          rootPath: args.rootPath,
          statusReporter: args.statusReporter,
        }))
      );
      continue;
    }
    if (!isFileNode(node)) {
      continue;
    }
    if (
      !args.entryPolicy.shouldIncludeFile({
        fileName: node.name,
        fileSize: node.size ?? 0,
        relativePath,
      })
    ) {
      args.onExcludedEntry();
      continue;
    }
    fileNodes.push(node);
  }
  return fileNodes;
}

async function collectChangedDirectoryFileNodes(args: {
  abortSignal: AbortSignal;
  deps: WorkspaceDiscoveryDeps;
  entryPolicy: WorkspaceIndexingEntryPolicy;
  onDirectoryTruncated: (path: string) => void;
  onExcludedEntry: () => void;
  relativePath: string;
  rootHandle: DirectoryHandle;
  rootPath: string;
  statusReporter: { report: (path: string | null) => void };
}): Promise<IFileNode[]> {
  const rootRelativePath = toRootRelativePath(
    args.rootPath,
    toRootAnchoredPath(args.rootPath, args.relativePath)
  );
  if (
    !args.entryPolicy.shouldTraverseDirectory({
      directoryName: getPathName(rootRelativePath),
      relativePath: rootRelativePath,
    })
  ) {
    args.onExcludedEntry();
    return [];
  }
  const directoryHandle = await resolveDirectoryHandleForRelativePath({
    abortSignal: args.abortSignal,
    deps: args.deps,
    entryPolicy: args.entryPolicy,
    onDirectoryTruncated: args.onDirectoryTruncated,
    onExcludedEntry: args.onExcludedEntry,
    relativePath: args.relativePath,
    rootHandle: args.rootHandle,
    rootPath: args.rootPath,
    statusReporter: args.statusReporter,
  });
  if (!directoryHandle) {
    return [];
  }
  return await readScopedDirectoryTree({
    abortSignal: args.abortSignal,
    deps: args.deps,
    directoryHandle,
    entryPolicy: args.entryPolicy,
    onDirectoryTruncated: args.onDirectoryTruncated,
    onExcludedEntry: args.onExcludedEntry,
    rootHandle: args.rootHandle,
    rootPath: args.rootPath,
    statusReporter: args.statusReporter,
  });
}

export async function collectScopedChange(args: {
  abortSignal: AbortSignal;
  accumulator: ScopedChangeAccumulator;
  change: FileSystemChange;
  context: { rootPath: string };
  deps: WorkspaceDiscoveryDeps;
  entryPolicy: WorkspaceIndexingEntryPolicy;
  onDirectoryTruncated: (path: string) => void;
  onExcludedEntry: () => void;
  onFileHandleResolutionFailure: (path: string) => void;
  rootHandle: DirectoryHandle;
  statusReporter: { report: (path: string | null) => void };
}): Promise<void> {
  if (args.change.type === 'removed') {
    if (isRootSelfPath(args.change.path, args.context.rootPath)) {
      return;
    }
    const relativePath = normalizeScopedChangePath(args.change, args.context.rootPath);
    if (relativePath === '') {
      return;
    }
    args.accumulator.pendingRemovals.push({ change: args.change, relativePath });
    return;
  }

  const relativePath = normalizeScopedChangePath(args.change, args.context.rootPath);
  if (args.change.kind === 'file') {
    const fileNode = await resolveChangedFileNode({
      abortSignal: args.abortSignal,
      deps: args.deps,
      entryPolicy: args.entryPolicy,
      onDirectoryTruncated: args.onDirectoryTruncated,
      onExcludedEntry: args.onExcludedEntry,
      onFileHandleResolutionFailure: args.onFileHandleResolutionFailure,
      relativePath,
      rootHandle: args.rootHandle,
      rootPath: args.context.rootPath,
      statusReporter: args.statusReporter,
    });
    if (fileNode) {
      args.accumulator.changedFileNodesByPath.set(relativePath, fileNode);
      args.accumulator.forceReadRelativePaths.add(relativePath);
    }
    return;
  }

  const subtreeFileNodes = await collectChangedDirectoryFileNodes({
    abortSignal: args.abortSignal,
    deps: args.deps,
    entryPolicy: args.entryPolicy,
    onDirectoryTruncated: args.onDirectoryTruncated,
    onExcludedEntry: args.onExcludedEntry,
    relativePath,
    rootHandle: args.rootHandle,
    rootPath: args.context.rootPath,
    statusReporter: args.statusReporter,
  });
  for (const fileNode of subtreeFileNodes) {
    const subtreeRelativePath = normalizeScopedChangePath(
      { kind: 'file', path: fileNode.path, type: 'modified' },
      args.context.rootPath
    );
    args.accumulator.changedFileNodesByPath.set(subtreeRelativePath, fileNode);
  }
}
