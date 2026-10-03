import type { DirectoryHandle, FileSystemChange, IFileNode } from '@brainstrike/types';
import {
  type BackgroundIndexingPolicyPreset,
  createBackgroundIndexingEntryPolicy,
} from '@brainstrike/utils/background-indexing-policy';
import { readFullTreeWithOptions } from './directory-tree.js';
import {
  collectScopedChange,
  type ScopedChangeAccumulator,
  type ScopedPendingRemoval,
  type WorkspaceDiscoveryDeps,
} from './workspace-scan-nodes.js';
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
  const entryPolicy = createBackgroundIndexingEntryPolicy({ preset: args.indexingPolicyPreset });
  let excludedEntries = 0;
  const truncatedDirectoryPaths = new Set<string>();
  const fileHandleResolutionFailurePaths = new Set<string>();
  const accumulator: ScopedChangeAccumulator = {
    changedFileNodesByPath: new Map(),
    forceReadRelativePaths: new Set(),
    pendingRemovals: [],
  };
  if (args.scope.mode === 'full') {
    const tree = await readFullTreeWithOptions(args.deps.fileSystemAdapter, args.rootHandle, {
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
      truncatedDirectoryPaths,
    };
  }
  for (const change of args.scope.changes) {
    await collectScopedChange({
      abortSignal: args.abortSignal,
      accumulator,
      change,
      context: { rootPath: args.rootPath },
      deps: args.deps,
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
  return {
    excludedEntries,
    fileHandleResolutionFailurePaths,
    fileNodes: [...accumulator.changedFileNodesByPath.values()],
    forceReadRelativePaths: accumulator.forceReadRelativePaths,
    pendingRemovals: accumulator.pendingRemovals,
    truncatedDirectoryPaths,
  };
}
