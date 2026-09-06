import type { ManagedCacheEntryMetadata, ManagedCacheInvalidationTarget } from '@brainstrike/db';
import type { FileContentProcessor } from '@brainstrike/file-explorer-hooks';
import { readFullTreeWithOptions } from '@brainstrike/file-explorer-ui/tree';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { WorkspaceIndexingQosPolicy } from '@brainstrike/indexing-contract/workspace-indexing-qos';
import { createLogger } from '@brainstrike/logging';
import type { FileSystemChange, IFileNode } from '@brainstrike/types';
import {
  type BackgroundIndexingPolicyPreset,
  createBackgroundIndexingEntryPolicy,
} from '@brainstrike/utils';
import { normalizeSelectionPathForFolder } from '@brainstrike/utils/relative-file-path';
import {
  type ChunkingRedispatchTracker,
  collectPreparedChangesInBatches,
  flattenFileNodes,
  type PreparedChangesSummary,
} from './workspace-collection-sync-import';
import { createScanningStatusReporter, throwIfAborted } from './workspace-collection-sync-progress';
import {
  countRelativePathSegments,
  getParentRelativePath,
  getPathName,
  isRootSelfPath,
  isUnderRelativePrefix,
  isUnderTruncatedDirectory,
  iterRelativePathSegments,
  normalizeScopedChangePath,
  toRootAnchoredPath,
  toRootRelativePath,
  toTruncatedRelativePrefixes,
} from './workspace-collection-sync-scan-paths';

interface RootDirectoryHandle {
  _internal?: unknown;
  kind: 'directory';
  name: string;
  path: string;
  platform: 'electron' | 'web';
  rootId?: string;
}

type WorkspaceCollectionSyncScanScope =
  | {
      mode: 'full';
    }
  | {
      changes: readonly FileSystemChange[];
      mode: 'paths';
    };

interface WorkspaceCollectionSyncScanRequest {
  indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  rootDirectoryHandle: RootDirectoryHandle | null;
  scope?: WorkspaceCollectionSyncScanScope;
}

interface ResolvedScanContext {
  activeRootPath: string;
  collectionId: string;
  dbRootId: string | null;
  rootPath: string;
}

interface WorkspaceCollectionSyncScanDeps {
  chunkingRedispatchTracker: ChunkingRedispatchTracker;
  fileContentProcessor?: FileContentProcessor;
  fileRecordRepository: {
    listManagedCacheEntryMetadata: (
      embeddingSetId: string
    ) => Promise<readonly ManagedCacheEntryMetadata[]>;
  };
  fileSystemAdapter: FileSystemAdapter;
  onScanningPath: (path: string | null) => void;
}

export interface PreparedSyncChanges {
  invalidationTargets: ManagedCacheInvalidationTarget[];
  prepared: PreparedChangesSummary;
}

interface ScopedChangeAccumulator {
  changedFileNodesByPath: Map<string, IFileNode>;
  forceReadRelativePaths: Set<string>;
  pendingRemovals: ScopedPendingRemoval[];
}

interface ScopedPendingRemoval {
  change: FileSystemChange;
  relativePath: string;
}

type WorkspaceIndexingEntryPolicy = ReturnType<typeof createBackgroundIndexingEntryPolicy>;

const logger = createLogger('WorkspaceCollectionSyncScan');

/**
 * A truncated adapter listing means the scan only saw the first N entries of a
 * directory, so the Workspace Index silently misses everything past the cap
 * unless the partial coverage is reported. One warning per scan; the count
 * also lands in the visible scan summary as `truncatedDirectories`.
 */
function warnOnTruncatedDirectories(truncatedDirectoryPaths: ReadonlySet<string>): void {
  if (truncatedDirectoryPaths.size === 0) {
    return;
  }
  logger.warn('Workspace Index scan consumed truncated directory listings; coverage is partial', {
    samplePaths: [...truncatedDirectoryPaths].slice(0, 10),
    truncatedDirectories: truncatedDirectoryPaths.size,
  });
}

function createEmptyPreparedSyncChanges(): PreparedSyncChanges {
  return {
    invalidationTargets: [],
    prepared: {
      changes: [],
      excludedEntries: 0,
      inaccessiblePaths: [],
      statRefreshes: [],
      terminalChunkingErrors: [],
      totalFiles: 0,
      truncatedDirectoryPaths: [],
      unchangedCount: 0,
    },
  };
}

function isDirectoryNode(node: IFileNode): boolean {
  return node.type === 'directory';
}

function isFileNode(node: IFileNode): boolean {
  return node.type === 'file';
}

function collectFullScanMissingFileInvalidations(args: {
  existingEntries: readonly ManagedCacheEntryMetadata[];
  fileNodes: readonly IFileNode[];
  rootId: string;
  rootPath: string;
  truncatedDirectoryPrefixes: readonly string[];
}): ManagedCacheInvalidationTarget[] {
  const scannedRelativePaths = new Set(
    args.fileNodes.map((node) =>
      normalizeSelectionPathForFolder(node.path, args.rootPath, {
        label: 'Background cache file path',
      })
    )
  );
  return args.existingEntries.flatMap((entry) => {
    if (entry.rootId !== args.rootId || scannedRelativePaths.has(entry.relativePath)) {
      return [];
    }
    // A truncated listing makes "absent from the scanned tree" unreliable:
    // rows past the cap are omitted, not deleted. Retain them (stale rows are
    // recoverable; deleting live rows is not).
    if (isUnderTruncatedDirectory(entry.relativePath, args.truncatedDirectoryPrefixes)) {
      return [];
    }
    return [
      {
        expectedFileRecordId: entry.fileRecordId,
        mode: 'exact',
        relativePath: entry.relativePath,
        rootId: args.rootId,
      } satisfies ManagedCacheInvalidationTarget,
    ];
  });
}

function toDirectoryHandle(node: IFileNode, rootHandle: RootDirectoryHandle): RootDirectoryHandle {
  const nodeHandle = node.handle as Partial<RootDirectoryHandle>;
  const rootId = nodeHandle.rootId ?? rootHandle.rootId;
  return {
    // On web, the child node's handle IS the raw FileSystemDirectoryHandle
    // (no _internal on it) and must become the rebuilt handle's _internal —
    // the web adapter can only read directories through it.
    _internal: nodeHandle._internal ?? node.handle,
    kind: 'directory',
    name: node.name,
    path: node.path,
    platform: nodeHandle.platform ?? rootHandle.platform,
    ...(rootId === undefined ? {} : { rootId }),
  };
}

function toSyntheticFileNode(args: {
  relativePath: string;
  rootHandle: RootDirectoryHandle;
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
    } as unknown as IFileNode['handle'],
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
  deps: WorkspaceCollectionSyncScanDeps;
  node: IFileNode;
  onResolutionFailure: (path: string) => void;
  rootHandle: RootDirectoryHandle;
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
function warnOnFileHandleResolutionFailures(failedPaths: ReadonlySet<string>): void {
  if (failedPaths.size === 0) {
    return;
  }
  logger.warn(
    'Workspace Index could not resolve readable file handles for changed paths; they will surface as inaccessible',
    {
      failedResolutions: failedPaths.size,
      samplePaths: [...failedPaths].slice(0, 10),
    }
  );
}

async function readDirectoryWithProgress(args: {
  abortSignal: AbortSignal;
  deps: WorkspaceCollectionSyncScanDeps;
  handle: RootDirectoryHandle;
  onDirectoryTruncated: (path: string) => void;
  statusReporter: ReturnType<typeof createScanningStatusReporter>;
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
  deps: WorkspaceCollectionSyncScanDeps;
  entryPolicy: WorkspaceIndexingEntryPolicy;
  onDirectoryTruncated: (path: string) => void;
  onExcludedEntry: () => void;
  relativePath: string;
  rootHandle: RootDirectoryHandle;
  rootPath: string;
  statusReporter: ReturnType<typeof createScanningStatusReporter>;
}): Promise<RootDirectoryHandle | null> {
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
  deps: WorkspaceCollectionSyncScanDeps;
  entryPolicy: WorkspaceIndexingEntryPolicy;
  onDirectoryTruncated: (path: string) => void;
  onExcludedEntry: () => void;
  onFileHandleResolutionFailure: (path: string) => void;
  relativePath: string;
  rootHandle: RootDirectoryHandle;
  rootPath: string;
  statusReporter: ReturnType<typeof createScanningStatusReporter>;
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
  deps: WorkspaceCollectionSyncScanDeps;
  directoryHandle: RootDirectoryHandle;
  entryPolicy: WorkspaceIndexingEntryPolicy;
  onDirectoryTruncated: (path: string) => void;
  onExcludedEntry: () => void;
  rootHandle: RootDirectoryHandle;
  rootPath: string;
  statusReporter: ReturnType<typeof createScanningStatusReporter>;
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

function makeInvalidationTargetKey(target: ManagedCacheInvalidationTarget): string {
  if (target.mode === 'prefix') {
    return `prefix:${target.rootId}:${target.relativePathPrefix}`;
  }
  return `exact:${target.rootId}:${target.relativePath}:${target.expectedFileRecordId ?? ''}`;
}

function dedupeInvalidationTargets(
  targets: readonly ManagedCacheInvalidationTarget[]
): ManagedCacheInvalidationTarget[] {
  const byKey = new Map<string, ManagedCacheInvalidationTarget>();
  for (const target of targets) {
    byKey.set(makeInvalidationTargetKey(target), target);
  }
  return [...byKey.values()];
}

function collectRemovedDirectoryEntryTargets(args: {
  existingEntries: readonly ManagedCacheEntryMetadata[];
  liveFilePaths: ReadonlySet<string>;
  removalRelativePath: string;
  rootId: string;
  truncatedDirectoryPrefixes: readonly string[];
}): ManagedCacheInvalidationTarget[] {
  const targets: ManagedCacheInvalidationTarget[] = [];
  for (const entry of args.existingEntries) {
    if (
      entry.rootId !== args.rootId ||
      !isUnderRelativePrefix(entry.relativePath, args.removalRelativePath) ||
      args.liveFilePaths.has(entry.relativePath) ||
      isUnderTruncatedDirectory(entry.relativePath, args.truncatedDirectoryPrefixes)
    ) {
      continue;
    }
    targets.push({
      expectedFileRecordId: entry.fileRecordId,
      mode: 'exact',
      relativePath: entry.relativePath,
      rootId: args.rootId,
    });
  }
  return targets;
}

function collectScopedRemovalInvalidations(args: {
  existingEntries: readonly ManagedCacheEntryMetadata[];
  liveFilePaths: ReadonlySet<string>;
  pendingRemovals: readonly ScopedPendingRemoval[];
  rootId: string;
  truncatedDirectoryPrefixes: readonly string[];
}): ManagedCacheInvalidationTarget[] {
  const targets: ManagedCacheInvalidationTarget[] = [];
  for (const removal of args.pendingRemovals) {
    if (removal.change.kind === 'file') {
      // Watcher-authoritative exact removal: recreation in the same batch is
      // re-resolved with a synthetic-node fallback, so truncation cannot hide
      // a live recreated file from this branch.
      if (args.liveFilePaths.has(removal.relativePath)) {
        continue;
      }
      targets.push({
        mode: 'exact',
        relativePath: removal.relativePath,
        rootId: args.rootId,
      });
      continue;
    }

    // Directory removals infer deletions from the re-listed live set; a
    // truncated listing anywhere over this subtree makes that set incomplete,
    // so absence-based invalidation must not run against it.
    if (isUnderTruncatedDirectory(removal.relativePath, args.truncatedDirectoryPrefixes)) {
      continue;
    }

    let foundLiveDescendant = false;
    for (const liveFilePath of args.liveFilePaths) {
      if (isUnderRelativePrefix(liveFilePath, removal.relativePath)) {
        foundLiveDescendant = true;
        break;
      }
    }
    if (!foundLiveDescendant) {
      targets.push({
        mode: 'prefix',
        relativePathPrefix: removal.relativePath,
        rootId: args.rootId,
      });
      continue;
    }

    targets.push(
      ...collectRemovedDirectoryEntryTargets({
        existingEntries: args.existingEntries,
        liveFilePaths: args.liveFilePaths,
        removalRelativePath: removal.relativePath,
        rootId: args.rootId,
        truncatedDirectoryPrefixes: args.truncatedDirectoryPrefixes,
      })
    );
  }
  return dedupeInvalidationTargets(targets);
}

async function collectChangedDirectoryFileNodes(args: {
  abortSignal: AbortSignal;
  deps: WorkspaceCollectionSyncScanDeps;
  entryPolicy: WorkspaceIndexingEntryPolicy;
  onDirectoryTruncated: (path: string) => void;
  onExcludedEntry: () => void;
  relativePath: string;
  rootHandle: RootDirectoryHandle;
  rootPath: string;
  statusReporter: ReturnType<typeof createScanningStatusReporter>;
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

async function collectScopedChange(args: {
  abortSignal: AbortSignal;
  accumulator: ScopedChangeAccumulator;
  change: FileSystemChange;
  context: ResolvedScanContext;
  deps: WorkspaceCollectionSyncScanDeps;
  entryPolicy: WorkspaceIndexingEntryPolicy;
  onDirectoryTruncated: (path: string) => void;
  onExcludedEntry: () => void;
  onFileHandleResolutionFailure: (path: string) => void;
  rootHandle: RootDirectoryHandle;
  statusReporter: ReturnType<typeof createScanningStatusReporter>;
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

async function collectPreparedFullChanges(args: {
  abortSignal: AbortSignal;
  context: ResolvedScanContext;
  deps: WorkspaceCollectionSyncScanDeps;
  qosPolicy: WorkspaceIndexingQosPolicy;
  request: WorkspaceCollectionSyncScanRequest;
}): Promise<PreparedSyncChanges> {
  if (!args.request.rootDirectoryHandle) {
    throw new Error('Workspace Index full scan requires a root directory handle.');
  }
  const entryPolicy = createBackgroundIndexingEntryPolicy({
    preset: args.request.indexingPolicyPreset,
  });
  const statusReporter = createScanningStatusReporter(args.deps.onScanningPath);
  let excludedEntries = 0;
  const truncatedDirectoryPaths = new Set<string>();

  try {
    const tree = await readFullTreeWithOptions(
      args.deps.fileSystemAdapter,
      args.request.rootDirectoryHandle,
      {
        abortSignal: args.abortSignal,
        entryPolicy,
        onDirectoryTruncated: ({ path }) => {
          truncatedDirectoryPaths.add(path);
        },
        onEntrySkipped: (entry) => {
          if (entry.reason === 'entry-policy') {
            excludedEntries += 1;
          }
        },
        propagateDirectoryReadErrors: true,
        updateProgress: (path?: string) => {
          statusReporter.report(path ?? null);
        },
      }
    );
    throwIfAborted(args.abortSignal);
    warnOnTruncatedDirectories(truncatedDirectoryPaths);

    const existingEntries = await args.deps.fileRecordRepository.listManagedCacheEntryMetadata(
      args.context.collectionId
    );
    throwIfAborted(args.abortSignal);
    const fileNodes = flattenFileNodes(tree);
    const rootId = args.context.dbRootId ?? '';

    const prepared = await collectPreparedChangesInBatches({
      abortSignal: args.abortSignal,
      chunkingRedispatchTracker: args.deps.chunkingRedispatchTracker,
      collectionId: args.context.collectionId,
      existingEntries,
      fileNodes,
      fileSystemAdapter: args.deps.fileSystemAdapter,
      onCurrentFile: (path) => {
        statusReporter.report(path);
      },
      pruneMissingRedispatchEntries: true,
      qosPolicy: args.qosPolicy,
      rootId,
      rootPath: args.context.activeRootPath,
      ...(args.deps.fileContentProcessor
        ? { fileContentProcessor: args.deps.fileContentProcessor }
        : {}),
    });
    statusReporter.flush(null);
    return {
      invalidationTargets: collectFullScanMissingFileInvalidations({
        existingEntries,
        fileNodes,
        rootId,
        rootPath: args.context.activeRootPath,
        truncatedDirectoryPrefixes: toTruncatedRelativePrefixes(
          truncatedDirectoryPaths,
          args.context.activeRootPath
        ),
      }),
      prepared: {
        ...prepared,
        // Tree-walk (entry-policy) exclusions PLUS the content-gate refusals
        // counted inside collectPreparedChangesInBatches — replacing instead of
        // summing silently dropped the content-gate count from the summary.
        excludedEntries: excludedEntries + prepared.excludedEntries,
        // Only the traversal observes truncation; the batch phase reports [].
        truncatedDirectoryPaths: [...truncatedDirectoryPaths],
      },
    };
  } finally {
    statusReporter.dispose();
  }
}

async function collectPreparedScopedChanges(args: {
  abortSignal: AbortSignal;
  changes: readonly FileSystemChange[];
  context: ResolvedScanContext;
  deps: WorkspaceCollectionSyncScanDeps;
  qosPolicy: WorkspaceIndexingQosPolicy;
  request: WorkspaceCollectionSyncScanRequest;
}): Promise<PreparedSyncChanges> {
  const rootHandle = args.request.rootDirectoryHandle;
  if (!rootHandle) {
    return createEmptyPreparedSyncChanges();
  }
  const entryPolicy = createBackgroundIndexingEntryPolicy({
    preset: args.request.indexingPolicyPreset,
  });
  const statusReporter = createScanningStatusReporter(args.deps.onScanningPath);
  let excludedEntries = 0;
  const onExcludedEntry = (): void => {
    excludedEntries += 1;
  };
  const truncatedDirectoryPaths = new Set<string>();
  const onDirectoryTruncated = (path: string): void => {
    truncatedDirectoryPaths.add(path);
  };
  const fileHandleResolutionFailurePaths = new Set<string>();
  const onFileHandleResolutionFailure = (path: string): void => {
    fileHandleResolutionFailurePaths.add(path);
  };
  const accumulator: ScopedChangeAccumulator = {
    changedFileNodesByPath: new Map<string, IFileNode>(),
    forceReadRelativePaths: new Set<string>(),
    pendingRemovals: [],
  };

  try {
    for (const change of args.changes) {
      await collectScopedChange({
        abortSignal: args.abortSignal,
        accumulator,
        change,
        context: args.context,
        deps: args.deps,
        entryPolicy,
        onDirectoryTruncated,
        onExcludedEntry,
        onFileHandleResolutionFailure,
        rootHandle,
        statusReporter,
      });
    }
    throwIfAborted(args.abortSignal);
    warnOnTruncatedDirectories(truncatedDirectoryPaths);
    warnOnFileHandleResolutionFailures(fileHandleResolutionFailurePaths);

    const existingEntries = await args.deps.fileRecordRepository.listManagedCacheEntryMetadata(
      args.context.collectionId
    );
    throwIfAborted(args.abortSignal);

    const prepared = await collectPreparedChangesInBatches({
      abortSignal: args.abortSignal,
      chunkingRedispatchTracker: args.deps.chunkingRedispatchTracker,
      collectionId: args.context.collectionId,
      existingEntries,
      fileNodes: [...accumulator.changedFileNodesByPath.values()],
      fileSystemAdapter: args.deps.fileSystemAdapter,
      forceReadRelativePaths: accumulator.forceReadRelativePaths,
      onCurrentFile: (path) => {
        statusReporter.report(path);
      },
      qosPolicy: args.qosPolicy,
      rootId: args.context.dbRootId ?? '',
      rootPath: args.context.activeRootPath,
      ...(args.deps.fileContentProcessor
        ? { fileContentProcessor: args.deps.fileContentProcessor }
        : {}),
    });
    statusReporter.flush(null);
    return {
      invalidationTargets: collectScopedRemovalInvalidations({
        existingEntries,
        liveFilePaths: new Set(accumulator.changedFileNodesByPath.keys()),
        pendingRemovals: accumulator.pendingRemovals,
        rootId: args.context.dbRootId ?? '',
        truncatedDirectoryPrefixes: toTruncatedRelativePrefixes(
          truncatedDirectoryPaths,
          args.context.rootPath
        ),
      }),
      prepared: {
        ...prepared,
        // Same summing contract as the full-scan path above.
        excludedEntries: excludedEntries + prepared.excludedEntries,
        truncatedDirectoryPaths: [...truncatedDirectoryPaths],
      },
    };
  } finally {
    statusReporter.dispose();
  }
}

export async function collectPreparedWorkspaceSyncChanges(args: {
  abortSignal: AbortSignal;
  context: ResolvedScanContext;
  deps: WorkspaceCollectionSyncScanDeps;
  qosPolicy: WorkspaceIndexingQosPolicy;
  request: WorkspaceCollectionSyncScanRequest;
}): Promise<PreparedSyncChanges> {
  if (args.request.scope?.mode === 'paths') {
    return await collectPreparedScopedChanges({
      ...args,
      changes: args.request.scope.changes,
    });
  }
  return await collectPreparedFullChanges(args);
}

export const __workspaceCollectionSyncScanInternalsForTests = {
  collectScopedRemovalInvalidations,
  countRelativePathSegments,
  getPathName,
  isUnderTruncatedDirectory,
  iterRelativePathSegments,
  toTruncatedRelativePrefixes,
};
