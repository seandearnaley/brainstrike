import type { IDatabase } from '../repositories/interfaces.js';
import { refreshCollectionIndexingStats } from '../services/collection-indexing-stats.js';

interface ManagedCacheRecordBase {
  content: string;
  contentHash: string;
  id: string;
  // Persisted filesystem mtime (epoch ms) for the background-sync stat-cache
  // fast-path. Null when the scan did not capture an mtime; such rows fall
  // through to read+hash until a later sync stamps real stats via
  // updateStatMetadata (hash-confirmed unchanged) or a write persists them.
  mtimeMs: number | null;
  name: string;
  path: string;
  processedAt: string;
  size: number;
  sourceRootPath: string;
  tokenCount: number;
  updatedAt: string;
}

export interface ManagedCacheImportRecord extends ManagedCacheRecordBase {
  createdAt: string;
}

export type ManagedCacheReplaceRecord = ManagedCacheRecordBase;

export type ManagedCacheBatchMutation =
  | {
      mode: 'import';
      record: ManagedCacheImportRecord;
    }
  | {
      mode: 'replace';
      record: ManagedCacheReplaceRecord;
    };

export interface ApplyManagedCacheBatchArgs {
  changes: readonly ManagedCacheBatchMutation[];
  embeddingSetId: string;
  // Per-batch root identifier: all changes in a batch share one root.
  // null means "no root assigned yet" (same as the pre-phase-3 default).
  readonly rootId?: string | null;
}

interface QueryLike {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const POSTGRES_PARAMETER_LIMIT = 65_535;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Coerce a filesystem mtime to a BIGINT-safe integer. The OS stat (and thus
 * IFileNode.lastModified) carries sub-millisecond fractional precision, e.g.
 * 1757381225844.767, which Postgres rejects for a BIGINT column with 22P02.
 * 1ms resolution is ample for change detection. Applied at the value boundary so
 * EVERY applyManagedCacheBatch caller is covered, not just the IPC-parsed path.
 */
function toBigIntMtime(value: number | null | undefined): number | null {
  // Same non-negative gate as parseManagedCacheRecordBase so the two mtime
  // boundaries stay consistent (a negative stat time is treated as absent).
  return isFiniteNonNegativeNumber(value) ? Math.floor(value) : null;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return isFiniteNonNegativeNumber(value) && Number.isInteger(value);
}

function isIsoTimestampString(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function parseManagedCacheRecordBase(record: unknown): ManagedCacheRecordBase | null {
  if (!(record && typeof record === 'object')) {
    return null;
  }

  const candidate = record as Record<string, unknown>;
  if (
    !(
      isNonEmptyString(candidate['id']) &&
      isNonEmptyString(candidate['name']) &&
      isNonEmptyString(candidate['path']) &&
      isFiniteNonNegativeInteger(candidate['size']) &&
      isNonEmptyString(candidate['sourceRootPath']) &&
      isIsoTimestampString(candidate['updatedAt']) &&
      isIsoTimestampString(candidate['processedAt']) &&
      typeof candidate['content'] === 'string' &&
      isNonEmptyString(candidate['contentHash']) &&
      isFiniteNonNegativeInteger(candidate['tokenCount'])
    )
  ) {
    return null;
  }

  // mtimeMs is optional best-effort stat metadata: a missing or non-numeric value
  // means "no mtime available" (→ null), which is a valid state, not malformed
  // input. The row simply won't benefit from the stat-cache until its next write.
  // Floor to an integer: the `mtime_ms` column is BIGINT but the OS stat carries
  // sub-millisecond fractional precision (e.g. 1757381225844.767), which Postgres
  // rejects as a bigint. 1ms resolution is ample for change detection.
  const mtimeMsCandidate = candidate['mtimeMs'];
  const mtimeMs = isFiniteNonNegativeNumber(mtimeMsCandidate) ? Math.floor(mtimeMsCandidate) : null;

  const parsedBase: ManagedCacheRecordBase = {
    id: candidate['id'],
    mtimeMs,
    name: candidate['name'],
    path: candidate['path'],
    size: candidate['size'],
    sourceRootPath: candidate['sourceRootPath'],
    updatedAt: candidate['updatedAt'],
    processedAt: candidate['processedAt'],
    content: candidate['content'],
    contentHash: candidate['contentHash'],
    tokenCount: candidate['tokenCount'],
  };
  return parsedBase;
}

function parseManagedCacheImportRecord(record: unknown): ManagedCacheImportRecord | null {
  const parsedBase = parseManagedCacheRecordBase(record);
  if (!parsedBase) {
    return null;
  }
  const candidate = record as Record<string, unknown>;
  if (!isIsoTimestampString(candidate['createdAt'])) {
    return null;
  }
  return {
    ...parsedBase,
    createdAt: candidate['createdAt'],
  };
}

function parseManagedCacheBatchMutation(change: unknown): ManagedCacheBatchMutation | null {
  if (!(change && typeof change === 'object')) {
    return null;
  }

  const candidate = change as Record<string, unknown>;
  if (candidate['mode'] === 'import') {
    const parsedRecord = parseManagedCacheImportRecord(candidate['record']);
    if (!parsedRecord) {
      return null;
    }
    return {
      mode: 'import',
      record: parsedRecord,
    };
  }

  if (candidate['mode'] === 'replace') {
    const parsedRecord = parseManagedCacheRecordBase(candidate['record']);
    if (!parsedRecord) {
      return null;
    }
    return {
      mode: 'replace',
      record: parsedRecord,
    };
  }

  return null;
}

export function parseManagedCacheBatchArgs(payload: unknown): ApplyManagedCacheBatchArgs {
  if (!(payload && typeof payload === 'object')) {
    throw new Error('Managed cache batch payload must be an object.');
  }

  const candidate = payload as Record<string, unknown>;
  if (!isNonEmptyString(candidate['embeddingSetId'])) {
    throw new Error('Managed cache batch payload requires a non-empty embeddingSetId.');
  }
  if (!Array.isArray(candidate['changes'])) {
    throw new Error('Managed cache batch payload requires a changes array.');
  }

  const changes = candidate['changes'].map((change) => {
    const parsedChange = parseManagedCacheBatchMutation(change);
    if (!parsedChange) {
      throw new Error('Managed cache batch payload contains an invalid change record.');
    }
    return parsedChange;
  });
  assertTotalBatchWithinLimit(changes.length);

  // rootId is per-batch (all changes in a batch share one root); must be a
  // non-empty string, null, or absent — any other value is a caller bug, not
  // silent coercion ('' would reach the DB as a doomed FK lookup).
  const rawRootId = candidate['rootId'];
  if (
    rawRootId !== undefined &&
    rawRootId !== null &&
    !(typeof rawRootId === 'string' && rawRootId.length > 0)
  ) {
    throw new Error('Managed cache batch payload rootId must be a non-empty string or null.');
  }

  return {
    embeddingSetId: candidate['embeddingSetId'],
    changes,
    ...(rawRootId === undefined ? {} : { rootId: rawRootId as string | null }),
  };
}

const IMPORT_COLUMNS = [
  'id',
  'name',
  'path',
  'size',
  'mtime_ms',
  'source_root_path',
  'created_at',
  'updated_at',
  'content',
  'content_hash',
  'token_count',
  'processed_at',
  'embedding_set_id',
  'root_id',
] as const;

const REPLACE_VALUE_COLUMNS = [
  'id',
  'name',
  'path',
  'size',
  'mtime_ms',
  'source_root_path',
  'updated_at',
  'content',
  'content_hash',
  'token_count',
  'processed_at',
] as const;

const MAX_MANAGED_CACHE_IMPORTS_PER_BATCH = Math.floor(
  POSTGRES_PARAMETER_LIMIT / IMPORT_COLUMNS.length
);
const MAX_MANAGED_CACHE_REPLACEMENTS_PER_BATCH = Math.floor(
  POSTGRES_PARAMETER_LIMIT / REPLACE_VALUE_COLUMNS.length
);
const MAX_MANAGED_CACHE_TOTAL_MUTATIONS_PER_BATCH =
  MAX_MANAGED_CACHE_IMPORTS_PER_BATCH + MAX_MANAGED_CACHE_REPLACEMENTS_PER_BATCH;

function assertTotalBatchWithinLimit(count: number): void {
  if (count <= MAX_MANAGED_CACHE_TOTAL_MUTATIONS_PER_BATCH) {
    return;
  }
  throw new Error(
    'Managed cache batch exceeds the maximum supported total size. ' +
      `Received ${count} changes; maximum supported batch size is ` +
      `${MAX_MANAGED_CACHE_TOTAL_MUTATIONS_PER_BATCH}.`
  );
}

function assertBatchWithinParameterLimit(
  count: number,
  maxCount: number,
  operation: 'import' | 'replace'
): void {
  if (count <= maxCount) {
    return;
  }
  throw new Error(
    `Managed cache batch ${operation} exceeds the PostgreSQL parameter limit. ` +
      `Received ${count} rows; maximum supported ${operation} batch size is ${maxCount}.`
  );
}

function assertNoDuplicateMutationIds(changes: readonly ManagedCacheBatchMutation[]): void {
  const seenIds = new Set<string>();
  for (const change of changes) {
    if (seenIds.has(change.record.id)) {
      throw new Error(`Managed cache batch contains duplicate file record id ${change.record.id}.`);
    }
    seenIds.add(change.record.id);
  }
}

function buildValuePlaceholders(rowCount: number, columnCount: number): string {
  const rows: string[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const placeholders: string[] = [];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      placeholders.push(`$${rowIndex * columnCount + columnIndex + 1}`);
    }
    rows.push(`(${placeholders.join(', ')})`);
  }
  return rows.join(', ');
}

function assertReturnedIds(
  resultRows: readonly { id?: unknown }[],
  expectedIds: readonly string[],
  operation: 'insert' | 'update'
): void {
  const returnedIds = new Set(
    resultRows.map((row) => row.id).filter((value): value is string => typeof value === 'string')
  );
  if (returnedIds.size !== expectedIds.length) {
    throw new Error(`Managed cache batch ${operation} affected an unexpected number of rows.`);
  }
  for (const expectedId of expectedIds) {
    if (!returnedIds.has(expectedId)) {
      throw new Error(`Managed cache batch ${operation} missed file record ${expectedId}.`);
    }
  }
}

async function insertManagedCacheImports(
  tx: QueryLike,
  embeddingSetId: string,
  imports: readonly ManagedCacheImportRecord[],
  rootId: string | null
): Promise<void> {
  if (imports.length === 0) {
    return;
  }

  const placeholders = buildValuePlaceholders(imports.length, IMPORT_COLUMNS.length);
  const values = imports.flatMap((record) => [
    record.id,
    record.name,
    record.path,
    record.size,
    toBigIntMtime(record.mtimeMs),
    record.sourceRootPath,
    record.createdAt,
    record.updatedAt,
    record.content,
    record.contentHash,
    record.tokenCount,
    record.processedAt,
    embeddingSetId,
    rootId,
  ]);

  const result = await tx.query<{ id: string }>(
    `INSERT INTO file_records (${IMPORT_COLUMNS.join(', ')})
     VALUES ${placeholders}
     RETURNING id`,
    values
  );

  assertReturnedIds(
    result.rows,
    imports.map((record) => record.id),
    'insert'
  );
}

async function applyManagedCacheReplacements(
  tx: QueryLike,
  embeddingSetId: string,
  replacements: readonly ManagedCacheReplaceRecord[]
): Promise<void> {
  if (replacements.length === 0) {
    return;
  }

  const replacementIds = replacements.map((record) => record.id);
  // Legacy migrations still persist text ids while newer schema surfaces use uuid columns.
  // Keep the text-form comparison here until that id contract is unified across both paths.
  await tx.query('DELETE FROM file_chunks WHERE file_record_id::text = ANY($1::text[])', [
    replacementIds,
  ]);

  const placeholders = buildValuePlaceholders(replacements.length, REPLACE_VALUE_COLUMNS.length);
  const values = replacements.flatMap((record) => [
    record.id,
    record.name,
    record.path,
    record.size,
    toBigIntMtime(record.mtimeMs),
    record.sourceRootPath,
    record.updatedAt,
    record.content,
    record.contentHash,
    record.tokenCount,
    record.processedAt,
  ]);
  const embeddingSetParamIndex = values.length + 1;

  const result = await tx.query<{ id: string }>(
    `UPDATE file_records
       SET name = replacement_values.name,
           path = replacement_values.path,
           size = replacement_values.size::integer,
           mtime_ms = replacement_values.mtime_ms::bigint,
           source_root_path = replacement_values.source_root_path,
           updated_at = replacement_values.updated_at::timestamptz,
           content = replacement_values.content,
           content_hash = replacement_values.content_hash,
           token_count = replacement_values.token_count::integer,
           processed_at = replacement_values.processed_at::timestamptz,
           embedding_set_id = $${embeddingSetParamIndex},
           chunks_count = 0,
           chunks_processed_at = NULL,
           chunking_strategy = NULL
      FROM (
        VALUES ${placeholders}
      ) AS replacement_values(
        id,
        name,
        path,
        size,
        mtime_ms,
        source_root_path,
        updated_at,
        content,
        content_hash,
        token_count,
        processed_at
      )
      -- Keep the text-form comparison aligned with the delete above until legacy text-id
      -- surfaces are retired and the managed-cache path can require one native id type.
      WHERE file_records.id::text = replacement_values.id::text
      RETURNING file_records.id`,
    [...values, embeddingSetId]
  );

  assertReturnedIds(result.rows, replacementIds, 'update');
}

export async function applyManagedCacheBatch(
  db: IDatabase,
  args: ApplyManagedCacheBatchArgs
): Promise<void> {
  if (args.changes.length === 0) {
    return;
  }
  if (!db.transaction) {
    throw new Error('Managed cache batch mutation requires transactional database support.');
  }
  assertTotalBatchWithinLimit(args.changes.length);
  assertNoDuplicateMutationIds(args.changes);

  const imports = args.changes.flatMap((change) =>
    change.mode === 'import' ? [change.record] : []
  );
  const replacements = args.changes.flatMap((change) =>
    change.mode === 'replace' ? [change.record] : []
  );
  assertBatchWithinParameterLimit(imports.length, MAX_MANAGED_CACHE_IMPORTS_PER_BATCH, 'import');
  assertBatchWithinParameterLimit(
    replacements.length,
    MAX_MANAGED_CACHE_REPLACEMENTS_PER_BATCH,
    'replace'
  );

  await db.transaction(async (tx) => {
    // Replacements must run first so stale chunks are cleared before any new rows in the same
    // batch are inserted. Reordering these calls changes conflict behavior and atomicity.
    // NOTE: applyManagedCacheReplacements does NOT set root_id — it is an UPDATE by id,
    // and the root of an existing record never changes on replace.
    await applyManagedCacheReplacements(tx, args.embeddingSetId, replacements);
    await insertManagedCacheImports(tx, args.embeddingSetId, imports, args.rootId ?? null);
    await refreshCollectionIndexingStats(tx, [args.embeddingSetId]);
  });
}
