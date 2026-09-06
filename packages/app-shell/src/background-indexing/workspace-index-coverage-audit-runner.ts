import type { WorkspaceCollectionSyncStatusPatch } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import type { DbHandle } from '@brainstrike/db/react';
import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils';
import {
  buildWorkspaceCoverageExpectedFiles,
  classifyMissingCoverageFiles,
  readIndexedRelativePathsByRoot,
  resolveMissingCoverageFiles,
  type WorkspaceCoverageExpectedFile,
  type WorkspaceCoverageGapClassification,
} from './workspace-index-coverage-audit';
import { countExpectedWorkspaceIndexFiles } from './workspace-index-debug-harness';

// Scope is deliberately unchanged by the move out of the provider (BST-1654):
// the coverage-audit exclusion diagnostics are an observable contract that
// tests and log consumers filter on, exactly as `background-permit-wait.ts`
// keeps this scope from its own file.
const logger = createLogger('WorkspaceCollectionSyncProvider');

/**
 * Coverage-audit ORCHESTRATION.
 *
 * This is the outer half of a two-layer audit and is deliberately NOT merged
 * with `./workspace-index-coverage-audit`, which owns the pure primitives
 * (expected-file construction, missing-file resolution, gap classification).
 * Everything here is orchestration those primitives must not know about:
 * assembling audit targets from the mounted roots, treating an unresolved db
 * root id or a truncated directory enumeration as first-class *unverifiable*
 * outcomes rather than gaps, composing user-facing messages and status
 * patches, and keying recovery attempts so one incomplete result triggers at
 * most one recovery sync.
 *
 * It lived inline in `workspace-collection-sync-provider.tsx` and never needed
 * React (BST-1654).
 */
export const WORKSPACE_COVERAGE_AUDIT_MESSAGE =
  'Verifying Workspace Index coverage before reporting idle.';

interface WorkspaceCoverageAuditTarget {
  readonly dbRootId: string;
  readonly expectedFileCount: number;
  readonly expectedFiles: readonly WorkspaceCoverageExpectedFile[];
  readonly rootPath: string;
}

type WorkspaceCoverageAuditOutcome =
  | {
      readonly kind: 'complete';
      readonly unindexableFileCount: number;
    }
  | {
      readonly kind: 'incomplete';
      readonly gapsByRoot: ReadonlyMap<string, WorkspaceCoverageGapClassification>;
      readonly indexedCounts: ReadonlyMap<string, number>;
      readonly message: string;
      readonly missingTargets: readonly WorkspaceCoverageAuditTarget[];
      readonly unindexableFileCount: number;
    }
  | {
      readonly kind: 'unresolved-root';
      readonly message: string;
      readonly rootPath: string;
    }
  | {
      readonly kind: 'truncated-root';
      readonly message: string;
      readonly rootPath: string;
    };
type WorkspaceCoverageIncompleteOutcome = Extract<
  WorkspaceCoverageAuditOutcome,
  { readonly kind: 'incomplete' }
>;
type WorkspaceCoverageUnverifiableOutcome = Extract<
  WorkspaceCoverageAuditOutcome,
  { readonly kind: 'truncated-root' | 'unresolved-root' }
>;
type WorkspaceCoverageAuditTargetResult =
  | WorkspaceCoverageAuditTarget
  | WorkspaceCoverageUnverifiableOutcome;

function parseDatabaseCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function readRootIdFromCountRow(row: unknown): string | null {
  if (!(row && typeof row === 'object')) {
    return null;
  }
  const record = row as Record<string, unknown>;
  const rootId = record['root_id'] ?? record['rootId'];
  return typeof rootId === 'string' && rootId.length > 0 ? rootId : null;
}

function readFileCountFromCountRow(row: unknown): number {
  if (!(row && typeof row === 'object')) {
    return 0;
  }
  const record = row as Record<string, unknown>;
  return parseDatabaseCount(record['file_count'] ?? record['fileCount'] ?? record['count']);
}

function isUnverifiableAuditOutcome(
  value: WorkspaceCoverageAuditTargetResult
): value is WorkspaceCoverageUnverifiableOutcome {
  return 'kind' in value && (value.kind === 'unresolved-root' || value.kind === 'truncated-root');
}

function isWorkspaceCoverageAuditTarget(
  value: WorkspaceCoverageAuditTargetResult
): value is WorkspaceCoverageAuditTarget {
  return !isUnverifiableAuditOutcome(value);
}

export async function readIndexedFileCountsByRoot(args: {
  collectionId: string;
  db: DbHandle;
  rootIds: readonly string[];
}): Promise<Map<string, number>> {
  if (args.rootIds.length === 0) {
    return new Map();
  }
  const rootPlaceholders = args.rootIds.map((_, index) => `$${index + 2}`).join(', ');
  const result = await args.db.query(
    `
      SELECT root_id, COUNT(*) AS file_count
      FROM file_records
      WHERE embedding_set_id = $1
        AND root_id IN (${rootPlaceholders})
      GROUP BY root_id
    `,
    [args.collectionId, ...args.rootIds]
  );
  const counts = new Map<string, number>();
  for (const row of Array.isArray(result.rows) ? result.rows : []) {
    const rootId = readRootIdFromCountRow(row);
    if (rootId) {
      counts.set(rootId, readFileCountFromCountRow(row));
    }
  }
  return counts;
}

const COVERAGE_MESSAGE_MISSING_PATH_SAMPLE_LIMIT = 3;

function describeCoverageGapForMessage(
  gap: WorkspaceCoverageGapClassification | undefined
): string {
  if (!gap) {
    return '';
  }
  const parts: string[] = [];
  if (gap.genuinelyMissing.length > 0) {
    const sample = gap.genuinelyMissing.slice(0, COVERAGE_MESSAGE_MISSING_PATH_SAMPLE_LIMIT);
    const remainder = gap.genuinelyMissing.length - sample.length;
    parts.push(
      `missing files include: ${sample.join(', ')}${remainder > 0 ? ` (+${remainder} more)` : ''}`
    );
  }
  if (gap.unclassifiedCount > 0) {
    parts.push(
      `${gap.unclassifiedCount} additional missing file${
        gap.unclassifiedCount === 1 ? ' was' : 's were'
      } not classified`
    );
  }
  if (gap.contentExcluded.length > 0) {
    parts.push(
      `${gap.contentExcluded.length} file${
        gap.contentExcluded.length === 1 ? ' is' : 's are'
      } unindexable by content policy`
    );
  }
  return parts.length > 0 ? `; ${parts.join('; ')}` : '';
}

function buildCoverageAuditMessage(args: {
  gapsByRoot: ReadonlyMap<string, WorkspaceCoverageGapClassification>;
  missingTargets: readonly WorkspaceCoverageAuditTarget[];
  indexedCounts: ReadonlyMap<string, number>;
}): string {
  const firstMissing = args.missingTargets[0];
  const rootSummary = args.missingTargets
    .slice(0, 3)
    .map((target) => {
      const indexedFileCount = args.indexedCounts.get(target.dbRootId) ?? 0;
      const gapSummary = describeCoverageGapForMessage(args.gapsByRoot.get(target.dbRootId));
      return `${target.rootPath} (${indexedFileCount}/${target.expectedFileCount} files indexed${gapSummary})`;
    })
    .join('; ');
  const extraCount =
    args.missingTargets.length > 3 ? `; +${args.missingTargets.length - 3} more` : '';
  return `Workspace Index coverage is incomplete after the pipeline reported idle: ${rootSummary}${extraCount}. A full recovery sync is required before this index can be treated as complete.${
    firstMissing ? ` First incomplete root: ${firstMissing.rootPath}.` : ''
  }`;
}
export function createCoverageAuditKey(args: {
  collectionId: string;
  handles: readonly DirectoryHandle[];
  policyPreset: BackgroundIndexingPolicyPreset;
  rootIdByPath: ReadonlyMap<string, string>;
}): string {
  const rootsKey = args.handles
    .map((handle) => `${handle.path}:${handle.rootId ?? args.rootIdByPath.get(handle.path) ?? ''}`)
    .join('|');
  return `${args.collectionId}:${args.policyPreset}:${rootsKey}`;
}

function createCoverageRecoveryAttemptKey(args: {
  auditKey: string;
  outcome: WorkspaceCoverageIncompleteOutcome;
}): string {
  const mismatchKey = args.outcome.missingTargets
    .map((target) => {
      const indexedFileCount = args.outcome.indexedCounts.get(target.dbRootId) ?? 0;
      return `${target.dbRootId}:${target.rootPath}:${indexedFileCount}/${target.expectedFileCount}`;
    })
    .sort()
    .join('|');
  return `${args.auditKey}:${mismatchKey}`;
}

/**
 * `unindexableFileCount` is three-valued on purpose, because the store
 * shallow-merges each patch and the count is rendered right next to
 * `lastError`:
 *   - a number publishes what THIS audit verified;
 *   - `null` publishes an explicit "unknown", clearing whatever the previous
 *     audit published — required whenever the outcome is unverifiable, or the
 *     user reads a hard count beside "coverage cannot be verified";
 *   - omitting the key keeps the previous value, and is ONLY correct while an
 *     audit is still running (the in-progress `waiting` patch), where the last
 *     verified count is still the best answer available.
 */
export function createCoverageStatusPatch(args: {
  activeRootPath: string | null;
  collectionId: string;
  lastError: string | null;
  state: 'error' | 'idle' | 'waiting';
  unindexableFileCount?: number | null;
}): WorkspaceCollectionSyncStatusPatch {
  return {
    activeRootPath: args.activeRootPath,
    currentFilePath: null,
    lastError: args.lastError,
    managedCollectionId: args.collectionId,
    pauseReasons: [],
    queuedFiles: 0,
    state: args.state,
    ...(args.unindexableFileCount === undefined
      ? {}
      : { unindexableFileCount: args.unindexableFileCount }),
  };
}

export function createUnresolvedRootCoverageMessage(rootPath: string): string {
  return `Workspace Index coverage cannot be verified because root ${rootPath} has no resolved database root id.`;
}

function createTruncatedRootCoverageMessage(
  rootPath: string,
  truncatedDirectoryCount: number
): string {
  return `Workspace Index coverage cannot be verified for root ${rootPath}: ${truncatedDirectoryCount} director${truncatedDirectoryCount === 1 ? 'y listing was' : 'y listings were'} truncated at the enumeration cap, so the expected file set is a partial prefix.`;
}

async function buildCoverageAuditTargets(args: {
  fileSystemAdapter: FileSystemAdapter;
  handles: readonly DirectoryHandle[];
  policyPreset: BackgroundIndexingPolicyPreset;
  resolveDbRootId: (path: string, rootId?: string) => Promise<string | null>;
  rootIdByPath: ReadonlyMap<string, string>;
}): Promise<readonly WorkspaceCoverageAuditTarget[] | WorkspaceCoverageAuditOutcome> {
  const targetResults: WorkspaceCoverageAuditTargetResult[] = await Promise.all(
    args.handles.map(async (handle) => {
      const adapterRootId = handle.rootId ?? args.rootIdByPath.get(handle.path);
      const dbRootId = await args.resolveDbRootId(handle.path, adapterRootId);
      if (!dbRootId) {
        return {
          kind: 'unresolved-root',
          message: createUnresolvedRootCoverageMessage(handle.path),
          rootPath: handle.path,
        };
      }
      const expected = await countExpectedWorkspaceIndexFiles({
        fileSystemAdapter: args.fileSystemAdapter,
        includeFiles: false,
        policyPreset: args.policyPreset,
        rootHandle: handle,
      });
      if (expected.truncatedDirectoryPaths.length > 0) {
        // The expected set is a partial prefix; a fully-indexed prefix must
        // not verify the root complete.
        return {
          kind: 'truncated-root',
          message: createTruncatedRootCoverageMessage(
            handle.path,
            expected.truncatedDirectoryPaths.length
          ),
          rootPath: handle.path,
        };
      }
      // Deduped by normalized relative path: file_records rows are keyed by
      // (rootId, relativePath), so the DB can never hold more rows than the
      // deduped expected set — a raw node count would over-count.
      const expectedFiles = buildWorkspaceCoverageExpectedFiles({
        fileNodes: expected.fileNodes,
        rootPath: handle.path,
      });
      return {
        dbRootId,
        expectedFileCount: expectedFiles.length,
        expectedFiles,
        rootPath: handle.path,
      };
    })
  );
  const unverifiableRoot = targetResults.find(isUnverifiableAuditOutcome);
  if (unverifiableRoot) {
    return unverifiableRoot;
  }
  return targetResults.filter(isWorkspaceCoverageAuditTarget);
}

function isCoverageAuditOutcome(
  value: readonly WorkspaceCoverageAuditTarget[] | WorkspaceCoverageAuditOutcome
): value is WorkspaceCoverageAuditOutcome {
  return !Array.isArray(value);
}

async function runWorkspaceCoverageAudit(args: {
  collectionId: string;
  db: DbHandle;
  fileSystemAdapter: FileSystemAdapter;
  handles: readonly DirectoryHandle[];
  isCurrent: () => boolean;
  policyPreset: BackgroundIndexingPolicyPreset;
  resolveDbRootId: (path: string, rootId?: string) => Promise<string | null>;
  rootIdByPath: ReadonlyMap<string, string>;
}): Promise<WorkspaceCoverageAuditOutcome | null> {
  if (!args.isCurrent()) {
    return null;
  }
  const targets = await buildCoverageAuditTargets(args);
  if (args.isCurrent()) {
    if (isCoverageAuditOutcome(targets)) {
      return targets;
    }
  } else {
    return null;
  }
  if (!args.isCurrent()) {
    return null;
  }
  // Compare SETS of relative paths, not counts: the DB is the source of truth
  // for what was indexed, and the on-disk walk for what should be. The set
  // difference names the actual missing files, which the content gate below
  // then classifies — a count comparison cannot distinguish "pipeline missed a
  // file" from "this file is legitimately unindexable".
  const indexedPathsByRoot = await readIndexedRelativePathsByRoot({
    collectionId: args.collectionId,
    db: args.db,
    rootIds: targets.map((target) => target.dbRootId),
  });
  if (!args.isCurrent()) {
    return null;
  }

  const indexedCounts = new Map<string, number>();
  const gapsByRoot = new Map<string, WorkspaceCoverageGapClassification>();
  const missingTargets: WorkspaceCoverageAuditTarget[] = [];
  const coveredContentExclusions: Array<{
    contentExcluded: WorkspaceCoverageGapClassification['contentExcluded'];
    rootPath: string;
  }> = [];
  // Roots are classified SEQUENTIALLY on purpose: each classification reads
  // missing files from disk with its own bounded concurrency, and this audit
  // runs as background QoS work — fanning out across roots would multiply IO
  // against foreground work for no user-visible gain.
  for (const target of targets) {
    const indexedRelativePaths = indexedPathsByRoot.get(target.dbRootId) ?? new Set<string>();
    const missingFiles = resolveMissingCoverageFiles({
      expectedFiles: target.expectedFiles,
      indexedRelativePaths,
    });
    indexedCounts.set(target.dbRootId, target.expectedFiles.length - missingFiles.length);
    if (missingFiles.length === 0) {
      continue;
    }
    // Re-apply the import pipeline's content gate to the missing files: a file
    // the gate refuses (null bytes, binary content, unreadable, too large) can
    // never be indexed and therefore counts as covered, not missing.
    const gap = await classifyMissingCoverageFiles({
      fileSystemAdapter: args.fileSystemAdapter,
      missingFiles,
      rootPath: target.rootPath,
    });
    if (!args.isCurrent()) {
      return null;
    }
    if (gap.genuinelyMissing.length === 0 && gap.unclassifiedCount === 0) {
      coveredContentExclusions.push({
        contentExcluded: gap.contentExcluded,
        rootPath: target.rootPath,
      });
      continue;
    }
    gapsByRoot.set(target.dbRootId, gap);
    missingTargets.push(target);
  }

  if (coveredContentExclusions.length > 0) {
    logger.info(
      'Workspace Index idle coverage audit: unindexable files excluded from coverage by content policy',
      {
        collectionId: args.collectionId,
        roots: coveredContentExclusions.map((entry) => ({
          contentExcluded: entry.contentExcluded,
          rootPath: entry.rootPath,
        })),
      }
    );
  }
  const unindexableFileCount =
    coveredContentExclusions.reduce((sum, entry) => sum + entry.contentExcluded.length, 0) +
    [...gapsByRoot.values()].reduce((sum, gap) => sum + gap.contentExcluded.length, 0);
  if (missingTargets.length === 0) {
    return { kind: 'complete', unindexableFileCount };
  }
  return {
    gapsByRoot,
    indexedCounts,
    kind: 'incomplete',
    message: buildCoverageAuditMessage({ gapsByRoot, indexedCounts, missingTargets }),
    missingTargets,
    unindexableFileCount,
  };
}

function applyWorkspaceCoverageAuditOutcome(args: {
  activeRootPath: string | null;
  auditKey: string;
  collectionId: string;
  markAuditVerified: (auditKey: string) => void;
  outcome: WorkspaceCoverageAuditOutcome;
  setStatus: (patch: WorkspaceCollectionSyncStatusPatch) => void;
}): string | null {
  if (args.outcome.kind === 'complete') {
    args.markAuditVerified(args.auditKey);
    args.setStatus(
      createCoverageStatusPatch({
        activeRootPath: args.activeRootPath,
        collectionId: args.collectionId,
        lastError: null,
        state: 'idle',
        unindexableFileCount: args.outcome.unindexableFileCount,
      })
    );
    return null;
  }
  if (args.outcome.kind === 'unresolved-root' || args.outcome.kind === 'truncated-root') {
    logger.warn(args.outcome.message, { rootPath: args.outcome.rootPath });
    args.setStatus(
      createCoverageStatusPatch({
        activeRootPath: args.outcome.rootPath,
        collectionId: args.collectionId,
        lastError: args.outcome.message,
        state: 'waiting',
        // Nothing was verified: publish the absence so a count from an earlier
        // audit cannot survive next to "coverage cannot be verified".
        unindexableFileCount: null,
      })
    );
    return null;
  }
  applyWorkspaceCoverageIncompleteOutcome({
    collectionId: args.collectionId,
    outcome: args.outcome,
    setStatus: args.setStatus,
  });
  return createCoverageRecoveryAttemptKey({ auditKey: args.auditKey, outcome: args.outcome });
}

function applyWorkspaceCoverageIncompleteOutcome(args: {
  collectionId: string;
  outcome: WorkspaceCoverageIncompleteOutcome;
  setStatus: (patch: WorkspaceCollectionSyncStatusPatch) => void;
}): void {
  logger.warn('Workspace Index idle coverage audit found incomplete roots', {
    collectionId: args.collectionId,
    missingRoots: args.outcome.missingTargets.map((target) => {
      const gap = args.outcome.gapsByRoot.get(target.dbRootId);
      return {
        contentExcluded: gap?.contentExcluded ?? [],
        expectedFileCount: target.expectedFileCount,
        genuinelyMissing: gap?.genuinelyMissing ?? [],
        indexedFileCount: args.outcome.indexedCounts.get(target.dbRootId) ?? 0,
        rootPath: target.rootPath,
        unclassifiedCount: gap?.unclassifiedCount ?? 0,
      };
    }),
  });
  args.setStatus(
    createCoverageStatusPatch({
      activeRootPath: args.outcome.missingTargets[0]?.rootPath ?? null,
      collectionId: args.collectionId,
      lastError: args.outcome.message,
      state: 'waiting',
      unindexableFileCount: args.outcome.unindexableFileCount,
    })
  );
}

export function startWorkspaceCoverageAudit(args: {
  activeRootPath: string | null;
  auditKey: string;
  clearInFlightAudit: (auditKey: string) => void;
  collectionId: string;
  db: DbHandle;
  fileSystemAdapter: FileSystemAdapter;
  handles: readonly DirectoryHandle[];
  isCurrent: () => boolean;
  markAuditVerified: (auditKey: string) => void;
  policyPreset: BackgroundIndexingPolicyPreset;
  resolveDbRootId: (path: string, rootId?: string) => Promise<string | null>;
  rootIdByPath: ReadonlyMap<string, string>;
  setStatus: (patch: WorkspaceCollectionSyncStatusPatch) => void;
}): Promise<string | null> {
  return runWorkspaceCoverageAudit({
    collectionId: args.collectionId,
    db: args.db,
    fileSystemAdapter: args.fileSystemAdapter,
    handles: args.handles,
    isCurrent: args.isCurrent,
    policyPreset: args.policyPreset,
    resolveDbRootId: args.resolveDbRootId,
    rootIdByPath: args.rootIdByPath,
  })
    .then((outcome) => {
      if (!outcome) {
        return null;
      }
      return applyWorkspaceCoverageAuditOutcome({
        activeRootPath: args.activeRootPath,
        auditKey: args.auditKey,
        collectionId: args.collectionId,
        markAuditVerified: args.markAuditVerified,
        outcome,
        setStatus: args.setStatus,
      });
    })
    .catch((error: unknown) => {
      if (!args.isCurrent()) {
        return null;
      }
      const message = `Workspace Index coverage audit failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      logger.error(message, { error });
      args.setStatus(
        createCoverageStatusPatch({
          activeRootPath: args.activeRootPath,
          collectionId: args.collectionId,
          lastError: message,
          state: 'error',
          // A failed audit verified nothing either.
          unindexableFileCount: null,
        })
      );
      return null;
    })
    .finally(() => {
      args.clearInFlightAudit(args.auditKey);
    });
}
