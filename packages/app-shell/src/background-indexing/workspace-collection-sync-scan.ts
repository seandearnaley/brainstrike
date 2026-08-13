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
import {
  isAbsoluteFileSystemPath,
  normalizeSelectionPathForFolder,
} from '@brainstrike/utils/relative-file-path';
import {
  type ChunkingRedispatchTracker,
  collectPreparedChangesInBatches,
  flattenFileNodes,
  type PreparedChangesSummary,
} from './workspace-collection-sync-import';
import { createScanningStatusReporter, throwIfAborted } from './workspace-collection-sync-progress';

interface RootDirectoryHandle {
  _internal?: unknown;
  kind: 'directory';
  name: string;
  path: string;
  platform: 'electron' | 'web';
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

const SLASH_CHAR_CODE = 47;

const logger = createLogger('WorkspaceCollectionSyncScan');

/**
 * Convert the walker's absolute truncated-directory paths into root-relative
 * prefixes ('' = the root itself) for absence-inference guards.
 */
function toTruncatedRelativePrefixes(
  truncatedDirectoryPaths: ReadonlySet<string>,
  rootPath: string
): string[] {
  const prefixes = new Set<string>();
  for (const path of truncatedDirectoryPaths) {
    if (toSlashPath(path.replace(/\\/g, '/')) === toSlashPath(rootPath)) {
      prefixes.add('');
      continue;
    }
    prefixes.add(
      normalizeSelectionPathForFolder(path, rootPath, {
        label: 'Workspace Index truncated directory path',
      })
    );
  }
  return [...prefixes];
}

function isUnderTruncatedDirectory(
  relativePath: string,
  truncatedDirectoryPrefixes: readonly string[]
): boolean {
  return truncatedDirectoryPrefixes.some(
    (prefix) => prefix === '' || relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  );
}

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

function toSlashPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '');
}

function joinRootRelativePath(rootPath: string, relativePath: string): string {
  const normalizedRoot = toSlashPath(rootPath);
  return `${normalizedRoot}/${relativePath.replace(/^\/+/u, '')}`;
}

function getPathName(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === SLASH_CHAR_CODE) {
    end -= 1;
  }
  if (end === 0) {
    return path;
  }
  const separatorIndex = path.lastIndexOf('/', end - 1);
  return path.slice(separatorIndex + 1, end);
}

function countRelativePathSegments(path: string): number {
  let count = 0;
  let inSegment = false;
  for (let index = 0; index < path.length; index += 1) {
    if (path.charCodeAt(index) === SLASH_CHAR_CODE) {
      inSegment = false;
      continue;
    }
    if (inSegment) {
      continue;
    }
    count += 1;
    inSegment = true;
  }
  return count;
}

function* iterRelativePathSegments(path: string): IterableIterator<string> {
  let start = 0;
  while (start < path.length) {
    while (start < path.length && path.charCodeAt(start) === SLASH_CHAR_CODE) {
      start += 1;
    }
    if (start >= path.length) {
      return;
    }
    let end = path.indexOf('/', start);
    if (end === -1) {
      end = path.length;
    }
    // Directory change resolution may run for many watcher paths; scanning here
    // avoids split/filter arrays while preserving empty-segment skipping.
    yield path.slice(start, end);
    start = end + 1;
  }
}

function getParentRelativePath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/').replace(/\/+$/u, '');
  const separatorIndex = normalized.lastIndexOf('/');
  return separatorIndex === -1 ? null : normalized.slice(0, separatorIndex);
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

function normalizeScopedChangePath(change: FileSystemChange, rootPath: string): string {
  const normalizedPath = change.path.replace(/\\/g, '/');
  const normalizedRoot = toSlashPath(rootPath);
  if (isAbsoluteFileSystemPath(normalizedPath)) {
    const pathLower = normalizedPath.toLowerCase();
    const rootLower = normalizedRoot.toLowerCase();
    if (!(pathLower === rootLower || pathLower.startsWith(`${rootLower}/`))) {
      throw new Error(`Workspace Index watcher path is outside the active root: ${change.path}`);
    }
  }
  return normalizeSelectionPathForFolder(normalizedPath, rootPath, {
    label: 'Workspace Index watcher path',
  });
}

function isRootSelfPath(path: string, rootPath: string): boolean {
  return toSlashPath(path.replace(/\\/g, '/')) === toSlashPath(rootPath);
}

function toDirectoryHandle(node: IFileNode, rootHandle: RootDirectoryHandle): RootDirectoryHandle {
  const nodeHandle = node.handle as Partial<RootDirectoryHandle>;
  return {
    kind: 'directory',
    name: node.name,
    path: node.path,
    platform: nodeHandle.platform ?? rootHandle.platform,
    ...(nodeHandle._internal === undefined ? {} : { _internal: nodeHandle._internal }),
  };
}

function toSyntheticFileNode(args: {
  relativePath: string;
  rootHandle: RootDirectoryHandle;
  rootPath: string;
}): IFileNode {
  const absolutePath = joinRootRelativePath(args.rootPath, args.relativePath);
  const fileName = getPathName(args.relativePath);
  return {
    // Watcher batches can synthesize many file nodes; scan once instead of
    // allocating split/filter arrays for every changed path.
    depth: countRelativePathSegments(args.relativePath),
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
  for (const segment of iterRelativePathSegments(args.relativePath)) {
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
      try {
        return (
          normalizeScopedChangePath(
            { kind: 'directory', path: node.path, type: 'modified' },
            args.rootPath
          ) === nextRelativePath
        );
      } catch {
        return false;
      }
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
  relativePath: string;
  rootHandle: RootDirectoryHandle;
  rootPath: string;
  statusReporter: ReturnType<typeof createScanningStatusReporter>;
}): Promise<IFileNode | null> {
  const parentRelativePath = getParentRelativePath(args.relativePath);
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
  let node = toSyntheticFileNode({
    relativePath: args.relativePath,
    rootHandle: args.rootHandle,
    rootPath: args.rootPath,
  });
  if (parentHandle) {
    const siblings = await readDirectoryWithProgress({
      abortSignal: args.abortSignal,
      deps: args.deps,
      handle: parentHandle,
      onDirectoryTruncated: args.onDirectoryTruncated,
      statusReporter: args.statusReporter,
    });
    const matchingNode = siblings.find((candidate) => {
      if (!(isFileNode(candidate) && candidate.name === fileName)) {
        return false;
      }
      try {
        return (
          normalizeScopedChangePath(
            { kind: 'file', path: candidate.path, type: 'modified' },
            args.rootPath
          ) === args.relativePath
        );
      } catch {
        return false;
      }
    });
    if (matchingNode) {
      node = matchingNode;
    }
  }
  if (
    !args.entryPolicy.shouldIncludeFile({
      fileName: node.name,
      fileSize: node.size ?? 0,
      relativePath: args.relativePath,
    })
  ) {
    args.onExcludedEntry();
    return null;
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
    const relativePath = normalizeScopedChangePath(
      {
        kind: node.type === 'directory' ? 'directory' : 'file',
        path: node.path,
        type: 'modified',
      },
      args.rootPath
    );
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

function isUnderRelativePrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
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
  if (
    !args.entryPolicy.shouldTraverseDirectory({
      directoryName: getPathName(args.relativePath),
      relativePath: args.relativePath,
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
        rootHandle,
        statusReporter,
      });
    }
    throwIfAborted(args.abortSignal);
    warnOnTruncatedDirectories(truncatedDirectoryPaths);

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
