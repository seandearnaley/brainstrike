import { readFullTreeWithOptions } from '@brainstrike/file-explorer-ui/tree';
import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils/background-indexing-policy';
import { createBackgroundIndexingEntryPolicy } from '@brainstrike/utils/background-indexing-policy';
import { normalizeSelectionPathForFolder } from '@brainstrike/utils/relative-file-path';
import { flattenFileNodes } from './workspace-collection-sync-import';

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

export interface WorkspaceIndexDebugAccessIssue {
  reason: string;
  source: string;
}

export interface WorkspaceIndexDebugSnapshot {
  accessIssues?: WorkspaceIndexDebugAccessIssue[];
  chunkedRecordsByRoot: unknown[];
  chunkingHostStatus: unknown;
  chunkStatsByRoot: unknown[];
  chunkStatsByRootAndSet: unknown[];
  databaseScheduler: unknown;
  embeddingHostStatus: unknown;
  expectedCounts: WorkspaceIndexExpectedFileCount[];
  fileRecordsByRoot: unknown[];
  jobQueue: unknown[];
  managedCollectionId: string | null;
  memorySample: unknown;
  roots: unknown[];
  runtimeReadiness: unknown;
  selectedDevicePreference: unknown;
  syncStatus: unknown;
}

export interface WorkspaceIndexDebugApi {
  configure: (options: { policyPreset?: BackgroundIndexingPolicyPreset }) => void;
  countExpected: () => Promise<WorkspaceIndexExpectedFileCount[]>;
  snapshot: () => Promise<WorkspaceIndexDebugSnapshot>;
  triggerFullSync: () => void;
}

export interface CountExpectedWorkspaceIndexFilesArgs {
  abortSignal?: AbortSignal;
  concurrency?: number;
  fileSystemAdapter: FileSystemAdapter;
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
  policyPreset,
  rootHandle,
}: CountExpectedWorkspaceIndexFilesArgs): Promise<WorkspaceIndexExpectedFileCount> {
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
  const includedFiles = flattenFileNodes(tree)
    .map((node) =>
      normalizeSelectionPathForFolder(node.path, rootHandle.path, {
        label: 'Workspace Index expected file path',
      })
    )
    .sort((left, right) => left.localeCompare(right));

  return {
    expectedFileCount: includedFiles.length,
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
      source,
      reason: 'database query bridge unavailable',
    });
    return [];
  }

  try {
    const result = await query(sql, params);
    return Array.isArray(result.rows) ? result.rows : [];
  } catch (error) {
    accessIssues.push({
      source,
      reason: error instanceof Error ? error.message : String(error),
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
