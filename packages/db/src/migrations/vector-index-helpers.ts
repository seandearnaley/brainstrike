import type { MigrationTransactionalDb } from './migration-runner';

function wantIvf(): boolean {
  try {
    const value = String(process.env['VECTOR_INDEX_TYPE'] || '').toLowerCase();
    return value === 'ivfflat' || value === 'ivf';
  } catch {
    return false;
  }
}

function ivfLists(): number {
  try {
    const parsed = Number(process.env['IVFFLAT_LISTS'] || '100');
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 100;
  } catch {
    return 100;
  }
}

function hnswParams(): { m: number; ef: number } {
  const m = Number(process.env['HNSW_M'] || '16');
  const ef = Number(process.env['HNSW_EF_CONSTRUCTION'] || '64');
  return {
    m: Number.isFinite(m) && m > 0 ? Math.floor(m) : 16,
    ef: Number.isFinite(ef) && ef > 0 ? Math.floor(ef) : 64,
  };
}

export async function dropExistingVectorIndexes(
  db: Pick<MigrationTransactionalDb, 'exec'>
): Promise<void> {
  try {
    await db.exec('DROP INDEX IF EXISTS idx_file_chunks_embedding_ivf');
  } catch {}
  try {
    await db.exec('DROP INDEX IF EXISTS idx_file_chunks_embedding_hnsw');
  } catch {}
  try {
    await db.exec('DROP INDEX IF EXISTS idx_file_chunks_embedding');
  } catch {}
}

export async function createVectorIndexes(db: MigrationTransactionalDb): Promise<void> {
  try {
    const hasVector = await db.query("SELECT 1 as one FROM pg_extension WHERE extname = 'vector'");
    if (!hasVector.rows?.length) {
      return;
    }
  } catch {
    return;
  }

  await dropExistingVectorIndexes(db);

  let lastError: unknown;

  if (wantIvf()) {
    const lists = ivfLists();
    try {
      await db.exec(
        `CREATE INDEX IF NOT EXISTS idx_file_chunks_embedding_ivf ON file_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists=${lists})`
      );
      return;
    } catch (error) {
      lastError = error;
      // fall back to HNSW below
    }
  }

  const { m, ef } = hnswParams();
  try {
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_file_chunks_embedding_hnsw ON file_chunks USING hnsw (embedding vector_cosine_ops) WITH (m=${m}, ef_construction=${ef})`
    );
    return;
  } catch (error) {
    lastError = error;
    // continue to default creation
  }

  try {
    await db.exec(
      'CREATE INDEX IF NOT EXISTS idx_file_chunks_embedding ON file_chunks USING hnsw (embedding vector_cosine_ops)'
    );
  } catch (error) {
    const parts: string[] = [];
    if (lastError) {
      parts.push(lastError instanceof Error ? lastError.message : String(lastError));
    }
    parts.push(error instanceof Error ? error.message : String(error));
    throw new Error(
      `Unable to create pgvector index on file_chunks.embedding: ${parts.join('; ')}`
    );
  }
}
