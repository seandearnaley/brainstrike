import type { ManagedCacheEntryMetadata, ManagedCacheInvalidationTarget } from '@brainstrike/db';
import type { FileContentProcessor } from '@brainstrike/file-explorer-hooks';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import { discoverWorkspaceFiles } from '@brainstrike/file-system/workspace-scan';
import {
  collectFullScanMissingFileInvalidations,
  collectScopedRemovalInvalidations,
} from '@brainstrike/file-system/workspace-scan-reconciliation';
import type { WorkspaceIndexingQosPolicy } from '@brainstrike/indexing-contract/workspace-indexing-qos';
import { createLogger } from '@brainstrike/logging';
import type { DirectoryHandle, FileSystemChange } from '@brainstrike/types';
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils';
import {
  type ChunkingRedispatchTracker,
  collectPreparedChangesInBatches,
  type PreparedChangesSummary,
} from './workspace-collection-sync-import';
import { createScanningStatusReporter, throwIfAborted } from './workspace-collection-sync-progress';
import {
  countRelativePathSegments,
  getPathName,
  isUnderTruncatedDirectory,
  iterRelativePathSegments,
  normalizeScopedChangePath,
  toTruncatedRelativePrefixes,
} from './workspace-collection-sync-scan-paths';

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
  rootDirectoryHandle: DirectoryHandle | null;
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

export async function collectPreparedWorkspaceSyncChanges(args: {
  abortSignal: AbortSignal;
  context: ResolvedScanContext;
  deps: WorkspaceCollectionSyncScanDeps;
  qosPolicy: WorkspaceIndexingQosPolicy;
  request: WorkspaceCollectionSyncScanRequest;
}): Promise<PreparedSyncChanges> {
  const rootHandle = args.request.rootDirectoryHandle;
  const scope = args.request.scope ?? { mode: 'full' };
  if (!rootHandle) {
    if (scope.mode === 'paths') {
      return createEmptyPreparedSyncChanges();
    }
    throw new Error('Workspace Index full scan requires a root directory handle.');
  }
  const statusReporter = createScanningStatusReporter(args.deps.onScanningPath);
  try {
    const discovery = await discoverWorkspaceFiles({
      abortSignal: args.abortSignal,
      deps: { fileSystemAdapter: args.deps.fileSystemAdapter },
      indexingPolicyPreset: args.request.indexingPolicyPreset,
      onScanningPath: statusReporter.report,
      rootHandle,
      rootPath: args.context.rootPath,
      scope,
    });
    throwIfAborted(args.abortSignal);
    warnOnTruncatedDirectories(discovery.truncatedDirectoryPaths);
    warnOnFileHandleResolutionFailures(discovery.fileHandleResolutionFailurePaths);
    const existingEntries = await args.deps.fileRecordRepository.listManagedCacheEntryMetadata(
      args.context.collectionId
    );
    throwIfAborted(args.abortSignal);
    const rootId = args.context.dbRootId ?? '';
    const prepared = await collectPreparedChangesInBatches({
      abortSignal: args.abortSignal,
      chunkingRedispatchTracker: args.deps.chunkingRedispatchTracker,
      collectionId: args.context.collectionId,
      existingEntries,
      fileNodes: discovery.fileNodes,
      fileSystemAdapter: args.deps.fileSystemAdapter,
      ...(scope.mode === 'paths'
        ? { forceReadRelativePaths: discovery.forceReadRelativePaths }
        : { pruneMissingRedispatchEntries: true }),
      onCurrentFile: statusReporter.report,
      qosPolicy: args.qosPolicy,
      rootId,
      rootPath: args.context.activeRootPath,
      ...(args.deps.fileContentProcessor
        ? { fileContentProcessor: args.deps.fileContentProcessor }
        : {}),
    });
    statusReporter.flush(null);
    const truncatedDirectoryPrefixes = toTruncatedRelativePrefixes(
      discovery.truncatedDirectoryPaths,
      scope.mode === 'full' ? args.context.activeRootPath : args.context.rootPath
    );
    const invalidationTargets =
      scope.mode === 'full'
        ? collectFullScanMissingFileInvalidations({
            existingEntries,
            fileNodes: discovery.fileNodes,
            rootId,
            rootPath: args.context.activeRootPath,
            truncatedDirectoryPrefixes,
          })
        : collectScopedRemovalInvalidations({
            existingEntries,
            liveFilePaths: new Set(
              discovery.fileNodes.map((node) =>
                normalizeScopedChangePath(
                  { kind: 'file', path: node.path, type: 'modified' },
                  args.context.rootPath
                )
              )
            ),
            pendingRemovals: discovery.pendingRemovals,
            rootId,
            truncatedDirectoryPrefixes,
          });
    return {
      invalidationTargets,
      prepared: {
        ...prepared,
        excludedEntries: discovery.excludedEntries + prepared.excludedEntries,
        truncatedDirectoryPaths: [...discovery.truncatedDirectoryPaths],
      },
    };
  } finally {
    statusReporter.dispose();
  }
}

export const __workspaceCollectionSyncScanInternalsForTests = {
  collectScopedRemovalInvalidations,
  countRelativePathSegments,
  getPathName,
  isUnderTruncatedDirectory,
  iterRelativePathSegments,
  toTruncatedRelativePrefixes,
};
