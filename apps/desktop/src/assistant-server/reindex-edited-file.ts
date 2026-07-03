import fsPromises from 'node:fs/promises';
import {
  type ApplyManagedCacheBatchArgs,
  applyManagedCacheBatch as applyManagedCacheBatchStandalone,
  getBrainstrikeDbExecutionRuntime,
  type ManagedCacheBatchMutation,
} from '@brainstrike/db';
import { generateContentHash } from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('ReindexEditedFile');

/**
 * The DB handle returned by `getDatabase()` (apps/desktop/src/db-main.ts) may be
 * local PGlite or a DB-host runtime client. PGlite can still drive the
 * standalone `applyManagedCacheBatch(db, args)` over `db.transaction`.
 * Turso must use the injected DB-host managed-cache applier so the mutation
 * stays on the owner-client Turso path and never falls through to the
 * PostgreSQL-shaped standalone implementation.
 * Structural so it stays trivially mockable in tests.
 */
export interface ReindexDatabaseHandle {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  transaction?: <TResult>(fn: (tx: unknown) => Promise<TResult>) => Promise<TResult>;
}

export interface ManagedCacheBatchApplier {
  applyManagedCacheBatch(args: ApplyManagedCacheBatchArgs): Promise<void>;
}

export interface ReindexEditedFileArgs {
  /** The exact bytes just written (UTF-8 decoded content the model produced). */
  readonly content: string;
  /** Filesystem mtime in epoch ms for the stat-cache fast-path, when available. */
  readonly mtimeMs: number | null;
  /** Display name (basename) for the file_records row. */
  readonly name: string;
  /** Workspace-relative path, no leading slash (matches file_records.path). */
  readonly relativePath: string;
  /** DB-resolved root id (= roots.id = file_records.root_id). */
  readonly rootId: string;
  /** Byte length written (file_records.size). */
  readonly size: number;
  /** The configured Workspace Index embedding set id, or undefined when indexing is off. */
  readonly workspaceIndexEmbeddingSetId: string | undefined;
}

interface FileRecordIdentityRow {
  id: string;
}

/**
 * Token estimate consistent with the existing import pipeline's
 * `estimateTokenCount` (Math.ceil(content.length / 4)) so a re-indexed row's
 * token_count matches what the background indexer would have stamped — we are
 * imitating that exact entry point, not inventing a new estimate.
 */
function estimateTokenCount(content: string): number {
  return Math.ceil(content.length / 4);
}

/**
 * Look up the EXISTING managed-cache file_records row for this path under the
 * Workspace Index set + root. Mirrors
 * `BaseFileRecordRepository.findByManagedCacheIdentity` exactly (same WHERE +
 * ORDER BY) but issues the query directly so the trigger stays runtime-agnostic
 * (the DB handle only needs `query`, which both runtimes expose). Returns the
 * row id when the file is genuinely indexed, otherwise null (→ no-op).
 */
async function findIndexedFileRecordId(
  db: ReindexDatabaseHandle,
  embeddingSetId: string,
  rootId: string,
  relativePath: string
): Promise<string | null> {
  const result = await db.query<FileRecordIdentityRow>(
    'SELECT id FROM file_records WHERE embedding_set_id = $1 AND root_id = $2 AND path = $3 ORDER BY updated_at DESC LIMIT 1',
    [embeddingSetId, rootId, relativePath]
  );
  const id = result.rows[0]?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Apply the managed-cache REPLACE the same way the background indexer does for a
 * changed file: it clears the file's stale chunks, cancels its in-flight
 * embed_chunk jobs, rewrites content/hash/tokens and sets
 * `chunks_processed_at = NULL` (marking the row un-chunked so the renderer
 * background sync re-chunks + re-embeds it), then refreshes
 * collection_indexing_stats. We never hand-roll chunking/embedding here.
 *
 * PGlite drives the standalone function over `db.transaction`. Turso requires
 * the injected DB-host applier; falling through to the standalone PostgreSQL
 * implementation is a hard error, not a compatibility fallback.
 */
async function applyManagedCacheReplace(
  db: ReindexDatabaseHandle,
  args: ApplyManagedCacheBatchArgs,
  managedCacheBatchApplier?: ManagedCacheBatchApplier | undefined
): Promise<void> {
  if (managedCacheBatchApplier) {
    await managedCacheBatchApplier.applyManagedCacheBatch(args);
    return;
  }

  if (getBrainstrikeDbExecutionRuntime(db) === 'turso') {
    throw new Error('Turso re-index requires the DB-host managed-cache applier.');
  }

  if (typeof db.transaction !== 'function') {
    throw new Error('Re-index requires a database handle with transaction support.');
  }
  await applyManagedCacheBatchStandalone(
    db as Parameters<typeof applyManagedCacheBatchStandalone>[0],
    args
  );
}

/**
 * Re-index a file the assistant just edited so RAG search (grep + semantic)
 * stays coherent instead of returning the pre-edit content.
 *
 * Ordering: the file is ALREADY written by the caller; this runs AFTER, so a
 * re-index failure can never lose the edit. It is non-fatal — every failure is
 * LOGGED (no silent swallow), and the caller does not await its rejection into
 * the tool result. Returns whether work was enqueued so tests/callers can assert
 * the no-op path.
 *
 * No-op (returns false) when:
 *  - no Workspace Index is configured (indexing off / no embedding set), or
 *  - the path is not part of the indexed set (no file_records row) — e.g. a file
 *    outside the indexed root, a new file not yet imported, or an excluded file.
 * In those cases there is nothing to keep coherent, so we enqueue nothing.
 */
export async function reindexEditedFile(
  db: ReindexDatabaseHandle,
  args: ReindexEditedFileArgs,
  managedCacheBatchApplier?: ManagedCacheBatchApplier | undefined
): Promise<boolean> {
  const embeddingSetId = args.workspaceIndexEmbeddingSetId?.trim();
  if (!embeddingSetId) {
    // No Workspace Index configured — the edit cannot affect any indexed set.
    return false;
  }

  const fileRecordId = await findIndexedFileRecordId(
    db,
    embeddingSetId,
    args.rootId,
    args.relativePath
  );
  if (!fileRecordId) {
    // The edited file is not part of the indexed set; nothing to re-index.
    logger.debug('Edited file is not indexed; skipping re-index', {
      embeddingSetId,
      rootId: args.rootId,
      relativePath: args.relativePath,
    });
    return false;
  }

  const now = new Date().toISOString();
  const replace: ManagedCacheBatchMutation = {
    mode: 'replace',
    record: {
      id: fileRecordId,
      name: args.name,
      path: args.relativePath,
      size: args.size,
      mtimeMs: args.mtimeMs,
      updatedAt: now,
      processedAt: now,
      content: args.content,
      contentHash: await generateContentHash(args.content),
      tokenCount: estimateTokenCount(args.content),
    },
  };

  await applyManagedCacheReplace(
    db,
    { embeddingSetId, changes: [replace] },
    managedCacheBatchApplier
  );
  logger.debug('Re-indexed edited file (chunks cleared, re-chunk pending)', {
    embeddingSetId,
    fileRecordId,
    relativePath: args.relativePath,
  });
  return true;
}

/**
 * Best-effort filesystem mtime (epoch ms) for the just-written file, used for
 * the managed-cache stat-cache fast-path. Returns null on any stat error — a
 * missing mtime is a valid state (the row falls back to read+hash on the next
 * sync), never a re-index failure.
 */
export async function statMtimeMs(absolutePath: string): Promise<number | null> {
  try {
    const stats = await fsPromises.stat(absolutePath);
    return Math.floor(stats.mtimeMs);
  } catch {
    return null;
  }
}
