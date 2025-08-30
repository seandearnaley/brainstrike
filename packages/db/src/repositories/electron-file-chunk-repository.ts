import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  FileChunk,
  FileChunkInsert,
  FileChunkUpdate,
} from '../models/file-chunk';
import {
  batchArray,
  computeCosineSimilarity,
  cosineToSearchSimilarity,
  parseEmbeddingLoose,
} from './_shared.js';
import type { ElectronDbAPI } from './electron-file-record-repository';

// Type definition for database row returned by Electron IPC
interface FileChunkRow {
  id: string;
  file_record_id: string;
  chunk_index: number;
  content: string;
  content_hash: string;
  token_count: number;
  chunk_type: 'text' | 'code' | 'sentence' | 'recursive';
  chunk_size: number;
  embedding?: string;
  // Phase 2 columns
  embedding_set_id?: string | null;
  embedding_updated_at?: string | null;
  embedding_hash?: string | null;
  created_at: string;
  updated_at: string;
}

// Type for search result rows with additional fields
interface FileChunkSearchRow extends FileChunkRow {
  similarity: string;
  rank: string;
}

// Type for stats query rows
interface FileChunkStatsRow {
  total_chunks: string;
  chunks_with_embeddings: string;
  average_token_count: string;
  chunk_type: string;
  type_count: string;
}

export class ElectronFileChunkRepository {
  constructor(
    private db: ElectronDbAPI,
    private vectorEnabled = false
  ) {}

  async findById(id: string): Promise<FileChunk | null> {
    const result = await this.db.query(
      'SELECT id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, embedding::text AS embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at FROM file_chunks WHERE id = $1',
      [id]
    );
    return result.rows[0] ? this.mapRowToChunk(result.rows[0] as FileChunkRow) : null;
  }

  async findByFileRecordId(fileRecordId: string): Promise<FileChunk[]> {
    const result = await this.db.query(
      'SELECT id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, embedding::text AS embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at FROM file_chunks WHERE file_record_id = $1 ORDER BY chunk_index ASC',
      [fileRecordId]
    );
    return result.rows.map((row) => this.mapRowToChunk(row as FileChunkRow));
  }

  async insert(chunk: FileChunkInsert): Promise<FileChunk> {
    const result = await this.db.query(
      `INSERT INTO file_chunks (
        id, file_record_id, chunk_index, content, content_hash, 
        token_count, chunk_type, chunk_size, embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) 
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        content_hash = EXCLUDED.content_hash,
        token_count = EXCLUDED.token_count,
        chunk_type = EXCLUDED.chunk_type,
        chunk_size = EXCLUDED.chunk_size,
        embedding = EXCLUDED.embedding,
        embedding_set_id = EXCLUDED.embedding_set_id,
        embedding_updated_at = EXCLUDED.embedding_updated_at,
        embedding_hash = EXCLUDED.embedding_hash,
        updated_at = EXCLUDED.updated_at
      RETURNING *`,
      [
        chunk.id,
        chunk.fileRecordId,
        chunk.chunkIndex,
        chunk.content,
        chunk.contentHash,
        chunk.tokenCount,
        chunk.chunkType,
        chunk.chunkSize,
        chunk.embedding ? `[${chunk.embedding.join(',')}]` : null,
        chunk.embeddingSetId ?? null,
        chunk.embeddingUpdatedAt ?? null,
        chunk.embeddingHash ?? null,
        chunk.createdAt,
        chunk.updatedAt,
      ]
    );
    return this.mapRowToChunk(result.rows[0] as FileChunkRow);
  }

  async insertMany(chunks: FileChunkInsert[]): Promise<FileChunk[]> {
    if (chunks.length === 0) {
      return [];
    }

    // Batch inserts to avoid parameter limit issues (250 rows per batch)
    const BatchSize = 250;
    const batches = batchArray(chunks, BatchSize);
    const allResults: FileChunk[] = [];

    // Process each batch in a transaction
    await this.db.query('BEGIN');
    try {
      for (const batch of batches) {
        const values = batch
          .map((_, index) => {
            const baseIndex = index * 14;
            return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9}, $${baseIndex + 10}, $${baseIndex + 11}, $${baseIndex + 12}, $${baseIndex + 13}, $${baseIndex + 14})`;
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
          chunk.embedding ? `[${chunk.embedding.join(',')}]` : null,
          chunk.embeddingSetId ?? null,
          chunk.embeddingUpdatedAt ?? null,
          chunk.embeddingHash ?? null,
          chunk.createdAt,
          chunk.updatedAt,
        ]);

        const result = await this.db.query(
          `INSERT INTO file_chunks (
              id, file_record_id, chunk_index, content, content_hash, 
              token_count, chunk_type, chunk_size, embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at
            ) VALUES ${values} 
            ON CONFLICT (id) DO UPDATE SET
              content = EXCLUDED.content,
              content_hash = EXCLUDED.content_hash,
              token_count = EXCLUDED.token_count,
              chunk_type = EXCLUDED.chunk_type,
              chunk_size = EXCLUDED.chunk_size,
              embedding = EXCLUDED.embedding,
              embedding_set_id = EXCLUDED.embedding_set_id,
              embedding_updated_at = EXCLUDED.embedding_updated_at,
              embedding_hash = EXCLUDED.embedding_hash,
              updated_at = EXCLUDED.updated_at
            RETURNING *`,
          params
        );

        allResults.push(...result.rows.map((row) => this.mapRowToChunk(row as FileChunkRow)));
      }
      await this.db.query('COMMIT');
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }

    return allResults;
  }

  async update(chunk: FileChunkUpdate): Promise<FileChunk | null> {
    const setParts: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (chunk.content !== undefined) {
      setParts.push(`content = $${paramIndex++}`);
      values.push(chunk.content);
    }
    if (chunk.contentHash !== undefined) {
      setParts.push(`content_hash = $${paramIndex++}`);
      values.push(chunk.contentHash);
    }
    if (chunk.tokenCount !== undefined) {
      setParts.push(`token_count = $${paramIndex++}`);
      values.push(chunk.tokenCount);
    }
    if (chunk.chunkType !== undefined) {
      setParts.push(`chunk_type = $${paramIndex++}`);
      values.push(chunk.chunkType);
    }
    if (chunk.chunkSize !== undefined) {
      setParts.push(`chunk_size = $${paramIndex++}`);
      values.push(chunk.chunkSize);
    }
    if (chunk.embedding !== undefined) {
      setParts.push(`embedding = $${paramIndex++}`);
      values.push(chunk.embedding ? `[${chunk.embedding.join(',')}]` : null);
      setParts.push(`embedding_updated_at = $${paramIndex++}`);
      values.push(chunk.embeddingUpdatedAt ?? chunk.updatedAt);
      if (chunk.embeddingSetId !== undefined) {
        setParts.push(`embedding_set_id = $${paramIndex++}`);
        values.push(chunk.embeddingSetId);
      }
      if (chunk.embeddingHash !== undefined) {
        setParts.push(`embedding_hash = $${paramIndex++}`);
        values.push(chunk.embeddingHash);
      }
    }

    setParts.push(`updated_at = $${paramIndex++}`);
    values.push(chunk.updatedAt);

    values.push(chunk.id);

    const result = await this.db.query(
      `UPDATE file_chunks SET ${setParts.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    return result.rows[0] ? this.mapRowToChunk(result.rows[0] as FileChunkRow) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM file_chunks WHERE id = $1', [id]);
    return (result as unknown as { rowCount: number }).rowCount > 0;
  }

  async deleteByFileRecordId(fileRecordId: string): Promise<number> {
    const result = await this.db.query('DELETE FROM file_chunks WHERE file_record_id = $1', [
      fileRecordId,
    ]);
    return (result as unknown as { rowCount: number }).rowCount;
  }

  async searchSimilar(
    queryEmbedding: number[],
    options: ChunkSearchOptions = {}
  ): Promise<ChunkSearchResult[]> {
    if (this.vectorEnabled) {
      // Use pgvector SQL path for optimal performance
      return this.searchSimilarPgVector(queryEmbedding, options);
    }

    // Use client-side computation fallback
    return this.searchSimilarClientSide(queryEmbedding, options);
  }

  private async searchSimilarPgVector(
    queryEmbedding: number[],
    options: ChunkSearchOptions = {}
  ): Promise<ChunkSearchResult[]> {
    const { limit = 10, threshold = 0.5, fileRecordId, chunkType, embeddingSetId } = options;

    let whereClause = 'WHERE embedding IS NOT NULL';
    const params: unknown[] = [`[${queryEmbedding.join(',')}]`];
    let paramIndex = 2;

    if (fileRecordId) {
      whereClause += ` AND file_record_id = $${paramIndex++}`;
      params.push(fileRecordId);
    }

    if (chunkType) {
      whereClause += ` AND chunk_type = $${paramIndex++}`;
      params.push(chunkType);
    }
    if (embeddingSetId) {
      whereClause += ` AND embedding_set_id = $${paramIndex++}`;
      params.push(embeddingSetId);
    }

    const result = await this.db.query(
      `SELECT *, 
        (1 - (embedding <=> $1::vector)) as similarity,
        ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) as rank
      FROM file_chunks 
      ${whereClause}
      AND (1 - (embedding <=> $1::vector)) >= $${paramIndex++}
      ORDER BY embedding <=> $1::vector
      LIMIT $${paramIndex}`,
      [...params, threshold, limit]
    );

    return result.rows.map((row) => {
      const searchRow = row as FileChunkSearchRow;
      return {
        chunk: this.mapRowToChunk(searchRow),
        similarity: Number.parseFloat(searchRow.similarity),
        rank: Number.parseInt(searchRow.rank, 10),
      };
    });
  }

  private async searchSimilarClientSide(
    queryEmbedding: number[],
    options: ChunkSearchOptions = {}
  ): Promise<ChunkSearchResult[]> {
    const { limit = 10, threshold = 0.5, fileRecordId, chunkType, embeddingSetId } = options;

    // Build WHERE clause for candidate selection
    let whereClause = 'WHERE embedding IS NOT NULL';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (fileRecordId) {
      whereClause += ` AND file_record_id = $${paramIndex++}`;
      params.push(fileRecordId);
    }

    if (chunkType) {
      whereClause += ` AND chunk_type = $${paramIndex++}`;
      params.push(chunkType);
    }
    if (embeddingSetId) {
      whereClause += ` AND embedding_set_id = $${paramIndex++}`;
      params.push(embeddingSetId);
    }

    // Retrieve candidates and parse embeddings on client-side
    const result = await this.db.query(
      `SELECT id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, embedding::text AS embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at 
      FROM file_chunks ${whereClause}`,
      params
    );

    interface SimilarityResult {
      chunk: FileChunk;
      similarity: number;
    }

    const candidatesWithSimilarity: SimilarityResult[] = [];

    // Compute similarities client-side
    for (const row of result.rows) {
      const chunkRow = row as FileChunkRow;
      const parsedEmbedding = parseEmbeddingLoose(chunkRow.embedding);

      if (!parsedEmbedding) {
        continue; // Skip chunks with unparseable embeddings
      }

      // Validate dimensions match
      if (parsedEmbedding.length !== queryEmbedding.length) {
        continue; // Skip mismatched dimensions gracefully
      }

      const cosineSim = computeCosineSimilarity(queryEmbedding, parsedEmbedding);
      const similarity = cosineToSearchSimilarity(cosineSim);

      if (Number.isFinite(similarity) && similarity >= threshold) {
        candidatesWithSimilarity.push({
          chunk: this.mapRowToChunk(chunkRow),
          similarity,
        });
      }
    }

    // Sort by similarity (descending) and apply limit
    candidatesWithSimilarity.sort((a, b) => b.similarity - a.similarity);
    const topResults = candidatesWithSimilarity.slice(0, limit);

    // Return with rank information
    return topResults.map((result, index) => ({
      chunk: result.chunk,
      similarity: result.similarity,
      rank: index + 1,
    }));
  }

  async findAll(): Promise<FileChunk[]> {
    const result = await this.db.query(
      'SELECT id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, embedding::text AS embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at FROM file_chunks ORDER BY created_at DESC'
    );
    return result.rows.map((row) => this.mapRowToChunk(row as FileChunkRow));
  }

  async getStats(): Promise<{
    totalChunks: number;
    chunksWithEmbeddings: number;
    averageTokenCount: number;
    chunkTypeDistribution: Record<string, number>;
  }> {
    const result = await this.db.query(`
      SELECT 
        COUNT(*) as total_chunks,
        COUNT(embedding) as chunks_with_embeddings,
        AVG(token_count) as average_token_count,
        chunk_type,
        COUNT(*) as type_count
      FROM file_chunks 
      GROUP BY chunk_type
    `);

    const stats = {
      totalChunks: 0,
      chunksWithEmbeddings: 0,
      averageTokenCount: 0,
      chunkTypeDistribution: {} as Record<string, number>,
    };

    for (const row of result.rows) {
      const rowData = row as FileChunkStatsRow;
      stats.totalChunks += Number.parseInt(rowData.type_count, 10);
      stats.chunksWithEmbeddings += Number.parseInt(rowData.chunks_with_embeddings, 10);
      stats.chunkTypeDistribution[rowData.chunk_type] = Number.parseInt(rowData.type_count, 10);
    }

    if (stats.totalChunks > 0) {
      stats.averageTokenCount =
        result.rows.reduce((acc: number, row) => {
          const rowData = row as FileChunkStatsRow;
          return (
            acc +
            Number.parseInt(rowData.average_token_count, 10) *
              Number.parseInt(rowData.type_count, 10)
          );
        }, 0) / stats.totalChunks;
    }

    return stats;
  }

  async clearAll(): Promise<number> {
    const countResult = await this.db.query('SELECT COUNT(*) as count FROM file_chunks');
    const countRow = countResult.rows[0];
    const totalCount =
      countRow && typeof countRow === 'object' && 'count' in countRow
        ? Number((countRow as { count: string }).count)
        : 0;

    await this.db.query('DELETE FROM file_chunks');
    return totalCount;
  }

  private mapRowToChunk(row: FileChunkRow): FileChunk {
    const embedding = row.embedding ? parseEmbeddingLoose(row.embedding) : undefined;
    return {
      id: row.id,
      fileRecordId: row.file_record_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      contentHash: row.content_hash,
      tokenCount: row.token_count,
      chunkType: row.chunk_type,
      chunkSize: row.chunk_size,
      ...(embedding && { embedding }),
      ...(row.embedding_set_id != null && { embeddingSetId: row.embedding_set_id }),
      ...(row.embedding_updated_at != null && { embeddingUpdatedAt: row.embedding_updated_at }),
      ...(row.embedding_hash != null && { embeddingHash: row.embedding_hash }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
