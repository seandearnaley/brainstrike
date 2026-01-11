import { describe, expect, it } from 'vitest';
import { normalizeEmbeddingSets } from '../utils/embedding-set-normalizer';

interface EmbeddingSetRow {
  id: string;
  model_key: string;
  model_id: string;
  dimensions: number;
  distance: string;
  created_at: string;
}

interface FileChunkRow {
  id: string;
  embedding_set_id: string | null;
}

function createMockDb({ sets, chunks }: { sets: EmbeddingSetRow[]; chunks: FileChunkRow[] }) {
  const state = {
    sets: [...sets],
    chunks: [...chunks],
  };

  function selectEmbeddingSets<T>(): { rows: T[] } {
    const rows = state.sets.map((set) => ({
      id: set.id,
      modelKey: set.model_key,
      modelId: set.model_id,
      dimensions: set.dimensions,
      distance: set.distance,
      createdAt: set.created_at,
    }));
    return { rows: rows as T[] };
  }

  function selectChunkCounts<T>(): { rows: T[] } {
    const counts = new Map<string, number>();
    for (const chunk of state.chunks) {
      if (!chunk.embedding_set_id) {
        continue;
      }
      counts.set(chunk.embedding_set_id, (counts.get(chunk.embedding_set_id) ?? 0) + 1);
    }
    const rows = Array.from(counts.entries()).map(([embeddingSetId, count]) => ({
      embeddingSetId,
      count,
    }));
    return { rows: rows as T[] };
  }

  function updateEmbeddingSetKey(nextKey: string, id: string) {
    state.sets = state.sets.map((set) => (set.id === id ? { ...set, model_key: nextKey } : set));
  }

  function reassignChunks(targetId: string, sourceId: string) {
    state.chunks = state.chunks.map((chunk) =>
      chunk.embedding_set_id === sourceId ? { ...chunk, embedding_set_id: targetId } : chunk
    );
  }

  function deleteEmbeddingSet(id: string) {
    state.sets = state.sets.filter((set) => set.id !== id);
  }

  async function query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const trimmed = sql.trim();
    if (trimmed.startsWith('SELECT id') && trimmed.includes('FROM embedding_sets')) {
      return selectEmbeddingSets<T>();
    }
    if (trimmed.startsWith('SELECT embedding_set_id') && trimmed.includes('FROM file_chunks')) {
      return selectChunkCounts<T>();
    }
    if (trimmed.startsWith('UPDATE embedding_sets')) {
      const [nextKey, id] = params as [string, string];
      updateEmbeddingSetKey(nextKey, id);
      return { rows: [] as T[] };
    }
    if (trimmed.startsWith('UPDATE file_chunks')) {
      const [targetId, sourceId] = params as [string, string];
      reassignChunks(targetId, sourceId);
      return { rows: [] as T[] };
    }
    if (trimmed.startsWith('DELETE FROM embedding_sets')) {
      const [id] = params as [string];
      deleteEmbeddingSet(id);
      return { rows: [] as T[] };
    }
    throw new Error(`Unhandled SQL in mock db: ${sql}`);
  }

  return {
    state,
    query,
  };
}

describe('normalizeEmbeddingSets', () => {
  it('merges duplicate sets and rewrites chunk references', async () => {
    const db = createMockDb({
      sets: [
        {
          id: 'set-a',
          model_key: 'local:jina-code',
          model_id: 'jina-code',
          dimensions: 768,
          distance: 'cosine',
          created_at: '2025-01-01T00:00:00.000Z',
        },
        {
          id: 'set-b',
          model_key: 'jina-code',
          model_id: 'jina-code',
          dimensions: 768,
          distance: 'cosine',
          created_at: '2025-01-02T00:00:00.000Z',
        },
      ],
      chunks: [
        { id: 'chunk-1', embedding_set_id: 'set-a' },
        { id: 'chunk-2', embedding_set_id: 'set-a' },
        { id: 'chunk-3', embedding_set_id: 'set-b' },
      ],
    });

    await normalizeEmbeddingSets(db);

    expect(db.state.sets).toHaveLength(1);
    expect(db.state.sets[0]).toMatchObject({
      id: 'set-a',
      model_key: 'local::jina-code',
    });
    expect(db.state.chunks.every((chunk) => chunk.embedding_set_id === 'set-a')).toBe(true);
  });

  it('is idempotent when called multiple times', async () => {
    const db = createMockDb({
      sets: [
        {
          id: 'set-c',
          model_key: 'openai::text-embedding-3-small',
          model_id: 'text-embedding-3-small',
          dimensions: 1536,
          distance: 'cosine',
          created_at: '2025-01-03T00:00:00.000Z',
        },
      ],
      chunks: [],
    });

    await normalizeEmbeddingSets(db);
    await normalizeEmbeddingSets(db);

    expect(db.state.sets).toHaveLength(1);
    const [onlySet] = db.state.sets;
    expect(onlySet?.model_key).toBe('openai::text-embedding-3-small');
  });
});
