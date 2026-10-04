import type { DirectoryHandle, FileSystemChange, IFileNode } from '@brainstrike/types';
import {
  type BackgroundIndexingPolicyPreset,
  createBackgroundIndexingEntryPolicy,
} from '@brainstrike/utils/background-indexing-policy';
import { readFullTreeWithOptions } from './directory-tree.js';
import { createWorkspaceScanIgnorePolicy, isWorkspaceIgnoreFile } from './workspace-scan-ignore.js';
import {
  collectScopedChange,
  type ScopedChangeAccumulator,
  type ScopedPendingRemoval,
  type WorkspaceDiscoveryDeps,
} from './workspace-scan-nodes.js';
import {
  getPathName,
  isRootSelfPath,
  isUnderTruncatedDirectory,
  normalizeScopedChangePath,
  toTruncatedRelativePrefixes,
} from './workspace-scan-paths.js';
import { flattenFileNodes } from './workspace-source-content.js';

export type WorkspaceScanScope =
  | { readonly mode: 'full' }
  | { readonly mode: 'paths'; readonly changes: readonly FileSystemChange[] };
export interface WorkspaceScanDiscovery {
  readonly excludedEntries: number;
  readonly fileHandleResolutionFailurePaths: ReadonlySet<string>;
  readonly fileNodes: readonly IFileNode[];
  readonly forceReadRelativePaths: ReadonlySet<string>;
  readonly pendingRemovals: readonly ScopedPendingRemoval[];
  readonly scope: WorkspaceScanScope;
  readonly truncatedDirectoryPaths: ReadonlySet<string>;
}

/** Same Workspace Index walk for web and utility; no catalog or root grant. */
export async function discoverWorkspaceFiles(args: {
  readonly abortSignal: AbortSignal;
  readonly deps: WorkspaceDiscoveryDeps;
  readonly indexingPolicyPreset: BackgroundIndexingPolicyPreset;
  readonly onScanningPath: (path: string | null) => void;
  readonly rootHandle: DirectoryHandle;
  readonly rootPath: string;
  readonly scope: WorkspaceScanScope;
}): Promise<WorkspaceScanDiscovery> {
  const scope =
    args.scope.mode === 'paths' &&
    args.scope.changes.some(
      (change) =>
        change.kind === 'file' &&
        !isRootSelfPath(change.path, args.rootPath) &&
        isWorkspaceIgnoreFile(getPathName(normalizeScopedChangePath(change, args.rootPath)))
    )
      ? { mode: 'full' as const }
      : args.scope;
  const { deps, entryPolicy } = createWorkspaceScanIgnorePolicy({
    deps: args.deps,
    entryPolicy: createBackgroundIndexingEntryPolicy({ preset: args.indexingPolicyPreset }),
    rootPath: args.rootPath,
    signal: args.abortSignal,
  });
  let excludedEntries = 0;
  const truncatedDirectoryPaths = new Set<string>();
  const fileHandleResolutionFailurePaths = new Set<string>();
  const accumulator: ScopedChangeAccumulator = {
    changedFileNodesByPath: new Map(),
    forceReadRelativePaths: new Set(),
    pendingRemovals: [],
  };
  const latestFileChanges = new Map<string, FileSystemChange['type']>();
  if (args.scope.mode === 'paths') {
    for (const change of args.scope.changes) {
      if (change.kind === 'file' && !isRootSelfPath(change.path, args.rootPath)) {
        const relativePath = normalizeScopedChangePath(change, args.rootPath);
        if (relativePath !== '') {
          latestFileChanges.set(relativePath, change.type);
        }
      }
    }
    // Full reconciliation and explicit changed-file reads are independent facts.
    for (const [relativePath, type] of latestFileChanges) {
      if (type !== 'removed') {
        accumulator.forceReadRelativePaths.add(relativePath);
      }
    }
  }
  if (scope.mode === 'full') {
    const tree = await readFullTreeWithOptions(deps.fileSystemAdapter, args.rootHandle, {
      abortSignal: args.abortSignal,
      entryPolicy,
      onDirectoryTruncated: ({ path }) => truncatedDirectoryPaths.add(path),
      onEntrySkipped: (entry) => {
        if (entry.reason === 'entry-policy') {
          excludedEntries += 1;
        }
      },
      propagateDirectoryReadErrors: true,
      updateProgress: (path) => args.onScanningPath(path ?? null),
    });
    args.abortSignal.throwIfAborted();
    return {
      excludedEntries,
      fileHandleResolutionFailurePaths,
      fileNodes: flattenFileNodes(tree),
      forceReadRelativePaths: accumulator.forceReadRelativePaths,
      pendingRemovals: [],
      scope,
      truncatedDirectoryPaths,
    };
  }
  for (const change of scope.changes) {
    await collectScopedChange({
      abortSignal: args.abortSignal,
      accumulator,
      change,
      context: { rootPath: args.rootPath },
      deps,
      entryPolicy,
      onDirectoryTruncated: (path) => truncatedDirectoryPaths.add(path),
      onExcludedEntry: () => {
        excludedEntries += 1;
      },
      onFileHandleResolutionFailure: (path) => fileHandleResolutionFailurePaths.add(path),
      rootHandle: args.rootHandle,
      statusReporter: { report: args.onScanningPath },
    });
  }
  args.abortSignal.throwIfAborted();
  const truncatedPrefixes = toTruncatedRelativePrefixes(truncatedDirectoryPaths, args.rootPath);
  const pendingRemovals = accumulator.pendingRemovals.filter(
    (removal) =>
      removal.change.kind !== 'file' ||
      latestFileChanges.get(removal.relativePath) === 'removed' ||
      !isUnderTruncatedDirectory(removal.relativePath, truncatedPrefixes)
  );
  return {
    excludedEntries,
    fileHandleResolutionFailurePaths,
    fileNodes: [...accumulator.changedFileNodesByPath.values()],
    forceReadRelativePaths: accumulator.forceReadRelativePaths,
    // A later file recreation remains live evidence even when unknown rules
    // withhold source admission. A complete excluded replacement still removes.
    pendingRemovals,
    scope,
    truncatedDirectoryPaths,
  };
}
