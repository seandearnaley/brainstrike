import type { PGlite } from '@electric-sql/pglite';
import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  FileChunk,
  FileChunkInsert,
  FileChunkUpdate,
} from '../models/file-chunk';

// Type definition for database row returned by PGlite
interface FileChunkRow {
  id: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  file_record_id: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  chunk_index: number;
  content: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  content_hash: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  token_count: number;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  chunk_type: 'text' | 'code' | 'sentence' | 'recursive';
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  chunk_size: number;
  embedding?: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  created_at: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  updated_at: string;
}

// Type for search result rows with additional fields
interface FileChunkSearchRow extends FileChunkRow {
  similarity: string;
  rank: string;
}

// Type for stats query rows
interface FileChunkStatsRow {
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  total_chunks: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  chunks_with_embeddings: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  average_token_count: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  chunk_type: string;
  // biome-ignore lint/style/useNamingConvention: Database column names use snake_case
  type_count: string;
}

export class FileChunkRepository {
  constructor(private db: PGlite) {}

  async findById(id: string): Promise<FileChunk | null> {
    const result = await this.db.query('SELECT * FROM file_chunks WHERE id = $1', [id]);
    return result.rows[0] ? this.mapRowToChunk(result.rows[0] as FileChunkRow) : null;
  }

  async findByFileRecordId(fileRecordId: string): Promise<FileChunk[]> {
    const result = await this.db.query(
      'SELECT * FROM file_chunks WHERE file_record_id = $1 ORDER BY chunk_index ASC',
      [fileRecordId]
    );
    return result.rows.map((row) => this.mapRowToChunk(row as FileChunkRow));
  }

  async insert(chunk: FileChunkInsert): Promise<FileChunk> {
    const result = await this.db.query(
      `INSERT INTO file_chunks (
        id, file_record_id, chunk_index, content, content_hash, 
        token_count, chunk_type, chunk_size, embedding, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
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
        chunk.createdAt,
        chunk.updatedAt,
      ]
    );
    return this.mapRowToChunk(result.rows[0] as FileChunkRow);
  }

  async insertMany(chunks: FileChunkInsert[]): Promise<FileChunk[]> {
    if (chunks.length === 0) return [];

    const values = chunks
      .map((_, index) => {
        const baseIndex = index * 11;
        return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9}, $${baseIndex + 10}, $${baseIndex + 11})`;
      })
      .join(', ');

    const params = chunks.flatMap((chunk) => [
      chunk.id,
      chunk.fileRecordId,
      chunk.chunkIndex,
      chunk.content,
      chunk.contentHash,
      chunk.tokenCount,
      chunk.chunkType,
      chunk.chunkSize,
      chunk.embedding ? `[${chunk.embedding.join(',')}]` : null,
      chunk.createdAt,
      chunk.updatedAt,
    ]);

    const result = await this.db.query(
      `INSERT INTO file_chunks (
        id, file_record_id, chunk_index, content, content_hash, 
        token_count, chunk_type, chunk_size, embedding, created_at, updated_at
      ) VALUES ${values} RETURNING *`,
      params
    );

    return result.rows.map((row) => this.mapRowToChunk(row as FileChunkRow));
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
    const { limit = 10, threshold = 0.5, fileRecordId, chunkType } = options;

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
        rank: Number.parseInt(searchRow.rank),
      };
    });
  }

  async findAll(): Promise<FileChunk[]> {
    const result = await this.db.query('SELECT * FROM file_chunks ORDER BY created_at DESC');
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
      stats.totalChunks += Number.parseInt(rowData.type_count);
      stats.chunksWithEmbeddings += Number.parseInt(rowData.chunks_with_embeddings);
      stats.chunkTypeDistribution[rowData.chunk_type] = Number.parseInt(rowData.type_count);
    }

    if (stats.totalChunks > 0) {
      stats.averageTokenCount =
        result.rows.reduce((acc: number, row) => {
          const rowData = row as FileChunkStatsRow;
          return (
            acc + Number.parseInt(rowData.average_token_count) * Number.parseInt(rowData.type_count)
          );
        }, 0) / stats.totalChunks;
    }

    return stats;
  }

  private mapRowToChunk(row: FileChunkRow): FileChunk {
    const embedding = row.embedding ? this.parseEmbedding(row.embedding) : undefined;
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private parseEmbedding(embeddingString: string): number[] | undefined {
    if (!embeddingString) return undefined;
    try {
      // Handle both array-like strings and actual arrays
      if (typeof embeddingString === 'string') {
        return JSON.parse(embeddingString);
      }
      return embeddingString as number[];
    } catch {
      return undefined;
    }
  }
}
