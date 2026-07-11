import { readFullTreeWithOptions } from '@brainstrike/file-explorer-ui/tree';
import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils/background-indexing-policy';
import { createBackgroundIndexingEntryPolicy } from '@brainstrike/utils/background-indexing-policy';
import { normalizeSelectionPathForFolder } from '@brainstrike/utils/relative-file-path';
import { flattenFileNodes } from './workspace-collection-sync-import';
import type {
  WorkspaceIndexStageBenchmarkRequest,
  WorkspaceIndexStageBenchmarkResult,
} from './workspace-index-debug-benchmark';

export interface WorkspaceIndexExpectedFileSkipCounts {
  defaultIgnore: number;
  entryPolicy: number;
  generatedOrIgnored: number;
}

export interface WorkspaceIndexExpectedFileCount {
  expectedFileCount: number;
  includedFiles: string[];
  policyPreset: BackgroundIndexingPolicyPreset;
  rootPath: string;
  skippedByReason: WorkspaceIndexExpectedFileSkipCounts;
}

export interface WorkspaceIndexExpectedFileCountWithNodes extends WorkspaceIndexExpectedFileCount {
  /** Flattened file nodes that passed the entry policy — the coverage audit
   * uses these to resolve and re-read the actual missing files. Not part of
   * the serializable debug shape (nodes carry live fs handles). */
  fileNodes: IFileNode[];
}

export interface WorkspaceIndexDebugAccessIssue {
  reason: string;
  source: string;
}

export interface WorkspaceIndexDebugSnapshot {
  accessIssues?: WorkspaceIndexDebugAccessIssue[];
  backgroundEffectiveHasHydrated?: boolean;
  backgroundPersistHasHydrated?: boolean;
  backgroundPreferences: unknown;
  chunkedRecordsByRoot: unknown[];
  chunkingHostStatus: unknown;
  chunkStatsByRoot: unknown[];
  chunkStatsByRootAndSet: unknown[];
  databaseScheduler: unknown;
  embeddingHostStatus: unknown;
  expectedCounts: WorkspaceIndexExpectedFileCount[];
  fileRecordsByRoot: unknown[];
  jobQueue: unknown[];
  jobQueueReadiness: unknown[];
  managedCollectionId: string | null;
  memorySample: unknown;
  recentEmbeddingFailures: unknown[];
  roots: unknown[];
  runtimeReadiness: unknown;
  selectedDevicePreference: unknown;
  syncLoop?: unknown;
  syncReadiness?: unknown;
  syncStatus: unknown;
  syncTargets?: unknown;
}

export interface WorkspaceIndexDebugSummary {
  accessIssues?: WorkspaceIndexDebugAccessIssue[];
  backgroundPreferences: unknown;
  chunkStatsByRootAndSet: unknown[];
  databaseScheduler: unknown;
  embeddingHostStatus: unknown;
  fileRecordsByRoot: unknown[];
  jobQueue: unknown[];
  jobQueueReadiness: unknown[];
  managedCollectionId: string | null;
  memorySample: unknown;
  recentEmbeddingFailures: unknown[];
  roots: unknown[];
  selectedDevicePreference: unknown;
  syncStatus: unknown;
}

export interface WorkspaceIndexDebugApi {
  benchmarkStage: (
    request: WorkspaceIndexStageBenchmarkRequest
  ) => Promise<WorkspaceIndexStageBenchmarkResult>;
  configure: (options: { policyPreset?: BackgroundIndexingPolicyPreset }) => void;
  countExpected: () => Promise<WorkspaceIndexExpectedFileCount[]>;
  snapshot: () => Promise<WorkspaceIndexDebugSnapshot>;
  summary: () => Promise<WorkspaceIndexDebugSummary>;
  triggerFullSync: () => void;
}

export interface CountExpectedWorkspaceIndexFilesArgs {
  abortSignal?: AbortSignal;
  concurrency?: number;
  fileSystemAdapter: FileSystemAdapter;
  includeFiles?: boolean;
  policyPreset: BackgroundIndexingPolicyPreset;
  rootHandle: DirectoryHandle;
}

export type WorkspaceIndexDebugDbQuery = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows?: unknown[] }>;

declare global {
  interface Window {
    /** App-shell-owned full Workspace Index verifier/debug surface. */
    // biome-ignore lint/style/useNamingConvention: Global debug API uses double underscores for discoverability.
    __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: WorkspaceIndexDebugApi | undefined;
  }
}

export async function countExpectedWorkspaceIndexFiles({
  abortSignal,
  concurrency,
  fileSystemAdapter,
  includeFiles = true,
  policyPreset,
  rootHandle,
}: CountExpectedWorkspaceIndexFilesArgs): Promise<WorkspaceIndexExpectedFileCountWithNodes> {
  const skippedByReason: WorkspaceIndexExpectedFileSkipCounts = {
    defaultIgnore: 0,
    entryPolicy: 0,
    generatedOrIgnored: 0,
  };
  const entryPolicy = createBackgroundIndexingEntryPolicy({ preset: policyPreset });
  const tree = await readFullTreeWithOptions(fileSystemAdapter, rootHandle, {
    abortSignal,
    concurrency,
    entryPolicy,
    onEntrySkipped: ({ reason }) => {
      if (reason === 'default-ignore') {
        skippedByReason.defaultIgnore += 1;
        skippedByReason.generatedOrIgnored += 1;
        return;
      }
      skippedByReason.entryPolicy += 1;
    },
    propagateDirectoryReadErrors: true,
  });
  const fileNodes = flattenFileNodes(tree);
  const includedFiles = includeFiles
    ? fileNodes
        .map((node) =>
          normalizeSelectionPathForFolder(node.path, rootHandle.path, {
            label: 'Workspace Index expected file path',
          })
        )
        .sort((left, right) => left.localeCompare(right))
    : [];

  return {
    expectedFileCount: fileNodes.length,
    fileNodes,
    includedFiles,
    policyPreset: entryPolicy.preset,
    rootPath: rootHandle.path,
    skippedByReason,
  };
}

export async function readWorkspaceIndexDebugRows(
  query: WorkspaceIndexDebugDbQuery | null | undefined,
  sql: string,
  params: unknown[],
  accessIssues: WorkspaceIndexDebugAccessIssue[],
  source: string
): Promise<unknown[]> {
  if (!query) {
    accessIssues.push({
      reason: 'database query bridge unavailable',
      source,
    });
    return [];
  }

  try {
    const result = await query(sql, params);
    return Array.isArray(result.rows) ? result.rows : [];
  } catch (error) {
    accessIssues.push({
      reason: error instanceof Error ? error.message : String(error),
      source,
    });
    return [];
  }
}

export function readWorkspaceIndexMemorySample(): unknown {
  if (typeof performance !== 'undefined') {
    const memory = (performance as Performance & { memory?: unknown }).memory;
    if (memory) {
      return memory;
    }
  }
  return null;
}

export function shouldExposeWorkspaceIndexDebugApi(
  env: Record<string, unknown> | undefined
): boolean {
  const desktopLifecycle =
    typeof window === 'undefined'
      ? undefined
      : (
          window as Window & {
            desktopLifecycle?: { isTestMode?: boolean };
          }
        ).desktopLifecycle;
  if (desktopLifecycle?.isTestMode === true) {
    return true;
  }
  if (typeof window !== 'undefined' && window.navigator.webdriver === true) {
    return true;
  }
  if (globalThis.process?.env?.['ELECTRON_IS_E2E_TEST'] === 'true') {
    return true;
  }
  if (globalThis.process?.env?.['NODE_ENV'] === 'production' || env?.['MODE'] === 'production') {
    return false;
  }
  return (
    globalThis.process?.env?.['NODE_ENV'] === 'test' ||
    env?.['DEV'] === true ||
    env?.['MODE'] === 'test'
  );
}
