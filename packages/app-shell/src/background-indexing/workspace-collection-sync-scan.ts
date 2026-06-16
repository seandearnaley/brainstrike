import type { ManagedCacheEntryMetadata, ManagedCacheInvalidationTarget } from '@brainstrike/db';
import type { FileContentProcessor } from '@brainstrike/file-explorer-hooks';
import { readFullTreeWithOptions } from '@brainstrike/file-explorer-ui/tree';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { FileSystemChange, IFileNode } from '@brainstrike/types';
import {
  type BackgroundIndexingPolicyPreset,
  createBackgroundIndexingEntryPolicy,
} from '@brainstrike/utils';
import {
  isAbsoluteFileSystemPath,
  normalizeSelectionPathForFolder,
} from '@brainstrike/utils/relative-file-path';
import type { WorkspaceIndexingQosPolicy } from '@brainstrike/utils/workspace-indexing-qos';
import {
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

function createEmptyPreparedSyncChanges(): PreparedSyncChanges {
  return {
    invalidationTargets: [],
    prepared: {
      changes: [],
      excludedEntries: 0,
      statRefreshes: [],
      totalFiles: 0,
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
  const segments = path.split('/').filter(Boolean);
  return segments.at(-1) ?? path;
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
  return {
    depth: args.relativePath.split('/').filter(Boolean).length,
    handle: {
      kind: 'file',
      name: getPathName(args.relativePath),
      path: absolutePath,
      platform: args.rootHandle.platform,
    } as unknown as IFileNode['handle'],
    name: getPathName(args.relativePath),
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
  throwIfAborted(args.abortSignal);
  return nodes;
}

async function resolveDirectoryHandleForRelativePath(args: {
  abortSignal: AbortSignal;
  deps: WorkspaceCollectionSyncScanDeps;
  entryPolicy: WorkspaceIndexingEntryPolicy;
  onExcludedEntry: () => void;
  relativePath: string;
  rootHandle: RootDirectoryHandle;
  rootPath: string;
  statusReporter: ReturnType<typeof createScanningStatusReporter>;
}): Promise<RootDirectoryHandle | null> {
  const segments = args.relativePath.split('/').filter(Boolean);
  let currentHandle = args.rootHandle;
  let currentRelativePath = '';
  for (const segment of segments) {
    const children = await readDirectoryWithProgress({
      abortSignal: args.abortSignal,
      deps: args.deps,
      handle: currentHandle,
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
  onExcludedEntry: () => void;
  rootHandle: RootDirectoryHandle;
  rootPath: string;
  statusReporter: ReturnType<typeof createScanningStatusReporter>;
}): Promise<IFileNode[]> {
  const children = await readDirectoryWithProgress({
    abortSignal: args.abortSignal,
    deps: args.deps,
    handle: args.directoryHandle,
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

function collectScopedRemovalInvalidations(args: {
  existingEntries: readonly ManagedCacheEntryMetadata[];
  liveFilePaths: ReadonlySet<string>;
  pendingRemovals: readonly ScopedPendingRemoval[];
  rootId: string;
}): ManagedCacheInvalidationTarget[] {
  const targets: ManagedCacheInvalidationTarget[] = [];
  for (const removal of args.pendingRemovals) {
    if (removal.change.kind === 'file') {
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

    for (const entry of args.existingEntries) {
      if (
        entry.rootId !== args.rootId ||
        !isUnderRelativePrefix(entry.relativePath, removal.relativePath) ||
        args.liveFilePaths.has(entry.relativePath)
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
  }
  return dedupeInvalidationTargets(targets);
}

async function collectChangedDirectoryFileNodes(args: {
  abortSignal: AbortSignal;
  deps: WorkspaceCollectionSyncScanDeps;
  entryPolicy: WorkspaceIndexingEntryPolicy;
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
  onExcludedEntry: () => void;
  rootHandle: RootDirectoryHandle;
  statusReporter: ReturnType<typeof createScanningStatusReporter>;
}): Promise<void> {
  const relativePath = normalizeScopedChangePath(args.change, args.context.rootPath);
  if (args.change.type === 'removed') {
    args.accumulator.pendingRemovals.push({ change: args.change, relativePath });
    return;
  }

  if (args.change.kind === 'file') {
    const fileNode = await resolveChangedFileNode({
      abortSignal: args.abortSignal,
      deps: args.deps,
      entryPolicy: args.entryPolicy,
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

  try {
    const tree = await readFullTreeWithOptions(
      args.deps.fileSystemAdapter,
      args.request.rootDirectoryHandle,
      {
        abortSignal: args.abortSignal,
        entryPolicy,
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

    const existingEntries = await args.deps.fileRecordRepository.listManagedCacheEntryMetadata(
      args.context.collectionId
    );
    throwIfAborted(args.abortSignal);
    const fileNodes = flattenFileNodes(tree);
    const rootId = args.context.dbRootId ?? '';

    const prepared = await collectPreparedChangesInBatches({
      abortSignal: args.abortSignal,
      existingEntries,
      fileNodes,
      fileSystemAdapter: args.deps.fileSystemAdapter,
      onCurrentFile: (path) => {
        statusReporter.report(path);
      },
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
      }),
      prepared: {
        ...prepared,
        excludedEntries,
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
        onExcludedEntry,
        rootHandle,
        statusReporter,
      });
    }
    throwIfAborted(args.abortSignal);

    const existingEntries = await args.deps.fileRecordRepository.listManagedCacheEntryMetadata(
      args.context.collectionId
    );
    throwIfAborted(args.abortSignal);

    const prepared = await collectPreparedChangesInBatches({
      abortSignal: args.abortSignal,
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
      }),
      prepared: {
        ...prepared,
        excludedEntries,
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
