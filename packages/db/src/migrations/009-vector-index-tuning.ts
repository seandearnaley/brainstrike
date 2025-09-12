import type { Migration } from './migration-runner';

function wantIvf(): boolean {
  try {
    const v = String(process.env['VECTOR_INDEX_TYPE'] || '').toLowerCase();
    return v === 'ivfflat' || v === 'ivf';
  } catch {
    return false;
  }
}

function ivfLists(): number {
  try {
    const v = Number(process.env['IVFFLAT_LISTS'] || '100');
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 100;
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

export const migration009VectorIndexTuning: Migration = {
  version: 9,
  name: 'vector_index_tuning',
  up: async (db) => {
    // Only proceed if vector extension is present and file_chunks table has a vector column
    try {
      const hasVector = await db.query(
        "SELECT 1 as one FROM pg_extension WHERE extname = 'vector'"
      );
      if (!hasVector.rows?.length) return;
    } catch {
      return;
    }

    // Drop existing generic index if present so we can create a tuned one
    try {
      await db.exec('DROP INDEX IF EXISTS idx_file_chunks_embedding');
    } catch {}

    if (wantIvf()) {
      // Try IVFFlat; fallback to HNSW on error
      const lists = ivfLists();
      try {
        await db.exec(
          `CREATE INDEX IF NOT EXISTS idx_file_chunks_embedding_ivf ON file_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists=${lists})`
        );
        return;
      } catch {
        // fall through to HNSW
      }
    }

    // HNSW with tunable params
    const { m, ef } = hnswParams();
    try {
      await db.exec(
        `CREATE INDEX IF NOT EXISTS idx_file_chunks_embedding_hnsw ON file_chunks USING hnsw (embedding vector_cosine_ops) WITH (m=${m}, ef_construction=${ef})`
      );
    } catch {
      // Last resort: try default HNSW without params
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_file_chunks_embedding ON file_chunks USING hnsw (embedding vector_cosine_ops)'
      );
    }
  },
  down: `
    DROP INDEX IF EXISTS idx_file_chunks_embedding_ivf;
    DROP INDEX IF EXISTS idx_file_chunks_embedding_hnsw;
    DROP INDEX IF EXISTS idx_file_chunks_embedding;
  `,
};
