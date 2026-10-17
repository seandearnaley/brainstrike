import type { GrepCandidate, GrepCandidateOptions } from '@brainstrike/utils/grep-search';
import type { FileChunk, FileChunkInsert } from '../models/file-chunk.js';
import { assertTextContentsHaveNoNullBytes } from '../text-content-invariants.js';
import {
  batchArray,
  MAX_INLINE_FILE_PATHS,
  type Queryable,
  validateEmbeddingDimensions,
} from './_shared.js';

/**
 * Shared file-chunk query bodies (BST-989 slice 2): the raw, Electron-IPC,
 * and Drizzle variants all delegate here so the SQL and row handling cannot
 * drift. The seam is a single parameterized-query function — raw/Electron
 * pass their db/tx handle's query, Drizzle passes its $client (the real
 * underlying PGlite), and callers keep their own row mappers only where the
 * variants' row shapes genuinely differ (insert RETURNING mapping).
 */
export type FileChunkRowQuery = (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

export async function runFindGrepCandidatesQuery(
  query: FileChunkRowQuery,
  options: GrepCandidateOptions
): Promise<GrepCandidate[]> {
  const { likePattern, caseSensitive, embeddingSetId, filePaths, limit, rootId, rootIds } = options;

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (likePattern !== null) {
    params.push(`%${likePattern}%`);
    const operator = caseSensitive ? 'LIKE' : 'ILIKE';
    conditions.push(`fc.content ${operator} $${params.length} ESCAPE '\\'`);
  }
  if (embeddingSetId !== undefined) {
    params.push(embeddingSetId);
    conditions.push(`fc.embedding_set_id = $${params.length}`);
  }
  if (rootId !== undefined) {
    params.push(rootId);
    conditions.push(`fr.root_id = $${params.length}`);
  }
  if (rootIds !== undefined) {
    if (rootIds.length === 0) {
      return []; // empty allowlist = nothing allowed (mirror filePaths semantics)
    }
    params.push(Array.from(rootIds));
    conditions.push(`fr.root_id = ANY($${params.length}::text[])`);
  }
  if (filePaths !== undefined) {
    if (filePaths.length === 0) {
      return []; // empty allowlist = nothing allowed
    }
    if (filePaths.length > MAX_INLINE_FILE_PATHS) {
      throw new Error(
        `findGrepCandidates filePaths limit exceeded (${filePaths.length} > ${MAX_INLINE_FILE_PATHS}).`
      );
    }
    params.push(Array.from(filePaths));
    conditions.push(`fr.path = ANY($${params.length}::text[])`);
  }
  params.push(limit);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // LEFT JOIN roots so legacy/unrooted files (root_id NULL) still appear; the
  // root id + display name travel with every candidate so matches stay
  // unambiguous across workspace roots that share a relative path.
  const result = await query(
    `SELECT fc.id AS chunk_id, fc.content, fc.start_line, fc.end_line, fr.path, fr.root_id, r.display_name
       FROM file_chunks fc
       JOIN file_records fr ON fr.id = fc.file_record_id
       LEFT JOIN roots r ON r.id = fr.root_id
       ${whereClause}
      ORDER BY fr.path, fc.chunk_index
      LIMIT $${params.length}`,
    params
  );

  return (
    result.rows as Array<{
      chunk_id: string;
      content: string;
      end_line: number | null;
      path: string;
      root_id: string | null;
      display_name: string | null;
      start_line: number | null;
    }>
  ).map((row) => ({
    chunkId: row.chunk_id,
    content: row.content,
    endLine: row.end_line,
    filePath: row.path,
    rootId: row.root_id,
    rootName: row.display_name,
    startLine: row.start_line,
  }));
}

export async function runInsertManyWithTx(
  tx: FileChunkRowQuery,
  chunks: FileChunkInsert[],
  mapRow: (row: unknown) => FileChunk
): Promise<FileChunk[]> {
  if (chunks.length === 0) {
    return [];
  }
  assertTextContentsHaveNoNullBytes(chunks, (chunk) => chunk.content, 'File chunk content');

  // Validate all embeddings before processing in batch
  await validateEmbeddingDimensions({ query: tx } as unknown as Queryable, chunks);

  const BatchSize = 250;
  const batches = batchArray(chunks, BatchSize);
  const allResults: FileChunk[] = [];
  for (const batch of batches) {
    const values = batch
      .map((_, index) => {
        const baseIndex = index * 18;
        return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9}, $${baseIndex + 10}, $${baseIndex + 11}, $${baseIndex + 12}, $${baseIndex + 13}, $${baseIndex + 14}, $${baseIndex + 15}, $${baseIndex + 16}, $${baseIndex + 17}, $${baseIndex + 18})`;
      })
      .join(', ');

    const params = batch.flatMap((chunk) => [
      chunk.id,
      chunk.fileRecordId,
      chunk.chunkIndex,
      chunk.content,
      chunk.contentHash,
      chunk.tokenCount,
      chunk.chunkType,
      chunk.chunkSize,
      chunk.startLine ?? null,
      chunk.endLine ?? null,
      chunk.startOffset ?? null,
      chunk.endOffset ?? null,
      chunk.embedding ? `[${chunk.embedding.join(',')}]` : null,
      chunk.embeddingSetId ?? null,
      chunk.embedding ? (chunk.embeddingUpdatedAt ?? chunk.updatedAt) : null,
      chunk.embeddingHash ?? null,
      chunk.createdAt,
      chunk.updatedAt,
    ]);

    const result = await tx(
      `INSERT INTO file_chunks (
          id, file_record_id, chunk_index, content, content_hash,
          token_count, chunk_type, chunk_size, start_line, end_line, start_offset, end_offset, embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at
        ) VALUES ${values}
        ON CONFLICT (id) DO UPDATE SET
          content = EXCLUDED.content,
          content_hash = EXCLUDED.content_hash,
          token_count = EXCLUDED.token_count,
          chunk_type = EXCLUDED.chunk_type,
          chunk_size = EXCLUDED.chunk_size,
          start_line = EXCLUDED.start_line,
          end_line = EXCLUDED.end_line,
          start_offset = EXCLUDED.start_offset,
          end_offset = EXCLUDED.end_offset,
          embedding = EXCLUDED.embedding,
          embedding_set_id = EXCLUDED.embedding_set_id,
          embedding_updated_at = EXCLUDED.embedding_updated_at,
          embedding_hash = EXCLUDED.embedding_hash,
          updated_at = EXCLUDED.updated_at
        RETURNING *`,
      params
    );

    allResults.push(...result.rows.map((row) => mapRow(row)));
  }
  return allResults;
}
