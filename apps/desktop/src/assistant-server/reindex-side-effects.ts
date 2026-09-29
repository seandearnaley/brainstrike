/**
 * Post-mutation Workspace Index coherence side effects (BST-743): the
 * re-index/invalidation triggers the file-mutation tools and the checkpoint
 * revert seam both run after a successful filesystem mutation. All are
 * non-fatal by contract — the mutation already succeeded, so failures are
 * logged (never swallowed, never propagated).
 *
 * Leaf module: depends on the database handle, the desktop work scheduler, the
 * background-indexer seam, and the shared file reader — never on
 * `assistant-tools.ts`, so no import cycle is possible.
 */
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import {
  createScheduledDbHandle,
  invalidateManagedCacheEntriesByIdentity,
  isBackgroundDatabaseWorkAdmitted,
} from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import {
  containDatabaseIntegrityError,
  DatabaseIntegrityError,
  getDesktopDatabaseIntegrity,
} from '../database-integrity-state';
import { getDatabase } from '../db-main';
import { getDesktopDatabaseWorkScheduler } from '../platform/desktop-database-work-scheduler';
import { type ReindexDatabaseHandle, reindexEditedFile, statMtimeMs } from './reindex-edited-file';
import { REDACTED_PATH_LOG_VALUE, redactToolErrorForLog } from './tool-execute-support';
import { readWorkspaceTextFile } from './workspace-text-file-reader';

const logger = createLogger('DesktopAssistantTools');

/**
 * Convert the normalized (leading-slash, forward-slash) workspace path the write
 * tools produce into the root-relative form stored in `file_records.path`
 * (no leading slash). Both edit tools share this so the re-index lookup keys the
 * same way the importer wrote the row.
 */
function toFileRecordRelativePath(workspacePath: string): string {
  return workspacePath.replace(/^\/+/, '');
}

const CONTAINMENT_SKIP_MESSAGE =
  'Skipped re-index: database integrity containment is active; the Workspace Index may be stale';

/**
 * Index maintenance after an edit or delete is background database work, so
 * while an integrity error is contained it is skipped — and said so: the edit
 * or delete already succeeded, and the index can only be stale (BST-1870).
 *
 * This pre-check is one read. Containment can start while the helper awaits
 * `getDatabase()` or between its own statements, so the actual database access
 * goes through {@link openBackgroundDatabase}, whose statements the scheduler
 * gates at their own start ({@link isPausedByDatabaseIntegrity}).
 */
function skipsWhileDatabaseIntegrityContained(): boolean {
  if (isBackgroundDatabaseWorkAdmitted(getDesktopDatabaseIntegrity().getSnapshot().state)) {
    return false;
  }
  logger.warn(CONTAINMENT_SKIP_MESSAGE);
  return true;
}

/**
 * The database handle for index maintenance: every query and transaction is a
 * `background` task on the desktop work scheduler, exactly like the embedding
 * backfill's handle (`ipc-embedding-backfill.ts`, `createScheduledDbHandle` over
 * `getDesktopDatabaseWorkScheduler()`). The scheduler's start-time gate then
 * rejects each statement, including the write, once containment is active.
 */
async function openBackgroundDatabase(): Promise<ReindexDatabaseHandle> {
  return createScheduledDbHandle(
    await getDatabase(),
    getDesktopDatabaseWorkScheduler(),
    'background'
  );
}

/** The scheduler gate refused a statement because containment began after the pre-check. */
function isPausedByDatabaseIntegrity(error: unknown): boolean {
  return error instanceof DatabaseIntegrityError && error.detail.reason === 'background-paused';
}

/**
 * Post-write hook (PR-2.3): keep the RAG index coherent after the agent edits a
 * file. The file is ALREADY written when this runs, so it runs AFTER the write
 * and is non-fatal — a re-index failure is LOGGED but never propagated, because
 * the edit already succeeded and the model is owed its write result regardless.
 *
 * It reuses the SAME entry point the background indexer uses for a changed file
 * (`applyManagedCacheBatch` in replace mode via {@link reindexEditedFile}):
 * stale chunks are cleared, in-flight embed jobs canceled, the row marked
 * un-chunked, and indexing stats refreshed. When the path is not part of the
 * Workspace Index (no embedding set, or no file_records row), it no-ops.
 *
 * Two failure tiers, both non-fatal (the edit already succeeded):
 *  - DB UNAVAILABLE (getDatabase() throws — e.g. no DB initialized, as in the
 *    DB-less unit tests): DEBUG log only. A missing DB is an environment state,
 *    not a re-index defect, so it must not raise alarm-level noise on every edit.
 *  - RE-INDEX FAILED on a real DB (the transaction throws): ERROR log, since a
 *    resolvable DB that then fails to re-index is a genuine, debuggable problem.
 */
export async function triggerEditedFileReindex(args: {
  runtimeData: RuntimeData | undefined;
  rootId: string;
  workspacePath: string;
  absolutePath: string;
  content: string;
  size: number;
}): Promise<void> {
  if (skipsWhileDatabaseIntegrityContained()) {
    return;
  }
  let db: ReindexDatabaseHandle;
  try {
    db = await openBackgroundDatabase();
  } catch (error) {
    // DB unavailable (no DB initialized). Non-fatal and expected outside a
    // running app — log at debug so it is traceable without alarming.
    logger.debug('Skipped re-index: database unavailable', {
      error: redactToolErrorForLog(error),
      path: REDACTED_PATH_LOG_VALUE,
    });
    return;
  }

  try {
    const relativePath = toFileRecordRelativePath(args.workspacePath);
    await reindexEditedFile(db, {
      content: args.content,
      mtimeMs: await statMtimeMs(args.absolutePath),
      name: path.basename(relativePath) || relativePath,
      relativePath,
      rootId: args.rootId,
      size: args.size,
      workspaceIndexEmbeddingSetId: args.runtimeData?.workspaceIndexEmbeddingSetId,
    });
  } catch (error) {
    if (isPausedByDatabaseIntegrity(error)) {
      // Containment began after the pre-check: the gate refused the write.
      logger.warn(CONTAINMENT_SKIP_MESSAGE);
      return;
    }
    // An integrity error pauses background writes for the whole app; the edit
    // itself still succeeded, so this stays non-fatal (and logged below).
    containDatabaseIntegrityError('assistant:reindex', error);
    // A resolvable DB that then fails to re-index is a genuine problem — surface
    // it (no silent swallow) but never fail the already-successful edit.
    logger.error('Failed to re-index edited file; RAG index may be stale until next sync', {
      error: redactToolErrorForLog(error),
      path: REDACTED_PATH_LOG_VALUE,
    });
  }
}

/**
 * Post-delete/-rename index coherence (mirrors {@link triggerEditedFileReindex}):
 * remove the file's Workspace Index rows (file_records + chunks) and cancel its
 * in-flight embed jobs via the SAME standalone seam the background watcher uses
 * for a disappeared file. Runs AFTER the filesystem mutation and is non-fatal —
 * the file is already gone/renamed on disk, so a failed invalidation is LOGGED
 * (never swallowed) and reported honestly as `indexInvalidated: false` rather
 * than failing the tool. Returns whether any indexed row was actually removed.
 *
 * No-op (returns false) when no Workspace Index is configured or the DB is
 * unavailable (as in the DB-less unit tests) — there is then nothing to keep
 * coherent. It also returns false, with a warning, while database integrity
 * containment pauses background writes — at the pre-check or when the scheduler
 * gate refuses the write: the index rows are then stale.
 */
export async function triggerFileDeletionInvalidation(args: {
  runtimeData: RuntimeData | undefined;
  rootId: string;
  workspacePath: string;
}): Promise<{ invalidated: boolean }> {
  const embeddingSetId = args.runtimeData?.workspaceIndexEmbeddingSetId?.trim();
  if (!embeddingSetId) {
    return { invalidated: false };
  }
  if (skipsWhileDatabaseIntegrityContained()) {
    return { invalidated: false };
  }

  let db: ReindexDatabaseHandle;
  try {
    db = await openBackgroundDatabase();
  } catch (error) {
    logger.debug('Skipped index invalidation: database unavailable', {
      error: redactToolErrorForLog(error),
      path: REDACTED_PATH_LOG_VALUE,
    });
    return { invalidated: false };
  }

  try {
    const result = await invalidateManagedCacheEntriesByIdentity(
      db as Parameters<typeof invalidateManagedCacheEntriesByIdentity>[0],
      {
        embeddingSetId,
        targets: [
          {
            mode: 'exact',
            relativePath: toFileRecordRelativePath(args.workspacePath),
            rootId: args.rootId,
          },
        ],
      }
    );
    return { invalidated: result.deletedFileRecordIds.length > 0 };
  } catch (error) {
    if (isPausedByDatabaseIntegrity(error)) {
      logger.warn(CONTAINMENT_SKIP_MESSAGE);
      return { invalidated: false };
    }
    containDatabaseIntegrityError('assistant:reindex', error);
    logger.error(
      'Failed to invalidate index rows for a removed/renamed file; RAG index may be stale until next sync',
      {
        error: redactToolErrorForLog(error),
        path: REDACTED_PATH_LOG_VALUE,
      }
    );
    return { invalidated: false };
  }
}

/**
 * Best-effort re-index of a rename DESTINATION through the same seam edits use
 * ({@link triggerEditedFileReindex}). That seam only UPDATES an existing
 * file_records row, so for a brand-new destination path (the common case — a
 * rename requires the target NOT to exist) it no-ops and the destination's row is
 * imported by the background workspace sync; it matters only when the destination
 * path had a stale row. Reading the content is bounded (2 MB + binary probe); a
 * binary/oversized/unreadable destination simply skips (non-fatal — the file is
 * already renamed on disk).
 *
 * Gated up front on `workspaceIndexEmbeddingSetId` (same derivation as
 * {@link triggerFileDeletionInvalidation}): with no Workspace Index configured
 * there is nothing to re-index, so this returns before paying for the up-to-2MB
 * destination read.
 */
export async function triggerRenamedDestinationReindex(args: {
  runtimeData: RuntimeData | undefined;
  rootId: string;
  rootPath: string;
  workspacePath: string;
  absolutePath: string;
}): Promise<void> {
  const embeddingSetId = args.runtimeData?.workspaceIndexEmbeddingSetId?.trim();
  if (!embeddingSetId) {
    return;
  }
  // Before the bounded destination read: nothing may be written, so the read is wasted.
  if (skipsWhileDatabaseIntegrityContained()) {
    return;
  }

  let file: { content: string; size: number };
  try {
    file = await readWorkspaceTextFile({
      requestedPath: args.workspacePath,
      rootPath: args.rootPath,
    });
  } catch (error) {
    logger.debug('Skipped renamed-destination re-index: not readable as text', {
      error: redactToolErrorForLog(error),
      path: REDACTED_PATH_LOG_VALUE,
    });
    return;
  }
  await triggerEditedFileReindex({
    absolutePath: args.absolutePath,
    content: file.content,
    rootId: args.rootId,
    runtimeData: args.runtimeData,
    size: file.size,
    workspacePath: args.workspacePath,
  });
}
