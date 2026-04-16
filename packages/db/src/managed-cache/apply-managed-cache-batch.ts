import type { IDatabase } from '../repositories/interfaces.js';

interface ManagedCacheRecordBase {
  content: string;
  contentHash: string;
  id: string;
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
}

interface QueryLike {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const IMPORT_COLUMNS = [
  'id',
  'name',
  'path',
  'size',
  'source_root_path',
  'created_at',
  'updated_at',
  'content',
  'content_hash',
  'token_count',
  'processed_at',
  'embedding_set_id',
] as const;

const REPLACE_VALUE_COLUMNS = [
  'id',
  'name',
  'path',
  'size',
  'source_root_path',
  'updated_at',
  'content',
  'content_hash',
  'token_count',
  'processed_at',
] as const;

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
  imports: readonly ManagedCacheImportRecord[]
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
    record.sourceRootPath,
    record.createdAt,
    record.updatedAt,
    record.content,
    record.contentHash,
    record.tokenCount,
    record.processedAt,
    embeddingSetId,
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
  await tx.query('DELETE FROM file_chunks WHERE file_record_id::text = ANY($1::text[])', [
    replacementIds,
  ]);

  const placeholders = buildValuePlaceholders(replacements.length, REPLACE_VALUE_COLUMNS.length);
  const values = replacements.flatMap((record) => [
    record.id,
    record.name,
    record.path,
    record.size,
    record.sourceRootPath,
    record.updatedAt,
    record.content,
    record.contentHash,
    record.tokenCount,
    record.processedAt,
  ]);
  const embeddingSetParamIndex = values.length + 1;

  const result = await tx.query<{ id: string }>(
    `UPDATE file_records AS file_records
       SET name = replacement_values.name,
           path = replacement_values.path,
           size = replacement_values.size,
           source_root_path = replacement_values.source_root_path,
           updated_at = replacement_values.updated_at,
           content = replacement_values.content,
           content_hash = replacement_values.content_hash,
           token_count = replacement_values.token_count,
           processed_at = replacement_values.processed_at,
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
        source_root_path,
        updated_at,
        content,
        content_hash,
        token_count,
        processed_at
      )
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

  const imports = args.changes.flatMap((change) =>
    change.mode === 'import' ? [change.record] : []
  );
  const replacements = args.changes.flatMap((change) =>
    change.mode === 'replace' ? [change.record] : []
  );

  await db.transaction(async (tx) => {
    await applyManagedCacheReplacements(tx, args.embeddingSetId, replacements);
    await insertManagedCacheImports(tx, args.embeddingSetId, imports);
  });
}
