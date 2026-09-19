import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStatementsInTransaction } from '../src/atomic-transaction.js';
import { DrizzleFileChunkRepository } from '../src/repositories/drizzle/file-chunk-repository.js';
import { ElectronFileChunkRepository } from '../src/repositories/electron-file-chunk-repository.js';
import type { ElectronDbAPI } from '../src/repositories/electron-file-record-repository.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import type { IFileChunkRepository } from '../src/repositories/interfaces.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const ROOT_A = '00000000-0000-0000-0000-000000001101';
const ROOT_B = '00000000-0000-0000-0000-000000001102';
const SET_ID = '00000000-0000-0000-0000-000000001103';
const SET_L2 = '00000000-0000-0000-0000-000000001109';
const SET_IP = '00000000-0000-0000-0000-000000001110';
const FILE_A = '00000000-0000-0000-0000-000000001104';
const FILE_B = '00000000-0000-0000-0000-000000001105';
const CHUNK_A = '00000000-0000-0000-0000-000000001106';
const CHUNK_B = '00000000-0000-0000-0000-000000001107';
const SNAPSHOT_ID = '00000000-0000-0000-0000-000000001108';
const EXPIRED_SNAPSHOT_ID = '00000000-0000-0000-0000-000000001111';
const QUERY_VECTOR = [1, 0, 0, 0];

interface AdapterFactory {
  create: (db: PGlite) => IFileChunkRepository;
  name: string;
}

function createElectronRepository(db: PGlite): IFileChunkRepository {
  const bridge: ElectronDbAPI = {
    exec: async (sql) => {
      await db.exec(sql);
    },
    query: async (sql, params) => {
      const result = await db.query(sql, params);
      return { rows: result.rows };
    },
    transaction: async (statements, resultIndex) =>
      runStatementsInTransaction(db, statements, resultIndex),
  };
  return new ElectronFileChunkRepository(bridge);
}

const ADAPTERS: AdapterFactory[] = [
  { create: (db) => new FileChunkRepository(db), name: 'raw PGlite' },
  { create: (db) => new DrizzleFileChunkRepository(drizzle(db)), name: 'Drizzle' },
  { create: createElectronRepository, name: 'Electron query bridge' },
];

async function seedSearchCorpus(db: PGlite): Promise<void> {
  await db.query(
    `INSERT INTO roots (id, kind, display_name, path, status) VALUES
       ($1, 'path', 'Alpha', '/alpha', 'live'),
       ($2, 'path', 'Beta', '/beta', 'live')`,
    [ROOT_A, ROOT_B]
  );
  await db.query(
    `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name) VALUES
       ($1, 'local:parity-cosine', 'local:parity-cosine', 4, 'cosine', 'Cosine'),
       ($2, 'local:parity-l2', 'local:parity-l2', 4, 'l2', 'L2'),
       ($3, 'local:parity-ip', 'local:parity-ip', 4, 'ip', 'Inner product')`,
    [SET_ID, SET_L2, SET_IP]
  );
  await db.query(
    `INSERT INTO file_records (id, root_id, name, path, size, embedding_set_id) VALUES
       ($1, $2, 'alpha.ts', 'src/alpha.ts', 100, $3),
       ($4, $5, 'beta.ts', 'src/beta.ts', 100, $3)`,
    [FILE_A, ROOT_A, SET_ID, FILE_B, ROOT_B]
  );
  await db.query(
    `INSERT INTO file_chunks
       (id, file_record_id, chunk_index, content, content_hash, chunk_type,
        start_line, end_line, token_count, embedding_set_id, embedding)
     VALUES
       ($1, $2, 0, 'authentication middleware validates every session token',
        'alpha-hash', 'code', 10, 14, 6, $3, '[1,0,0,0]'),
       ($4, $5, 0, 'authorization handler rejects an invalid credential',
        'beta-hash', 'code', 20, 24, 6, $3, '[0,1,0,0]')`,
    [CHUNK_A, FILE_A, SET_ID, CHUNK_B, FILE_B]
  );
  await db.query(
    `INSERT INTO file_chunks
       (id, file_record_id, chunk_index, content, embedding_set_id, embedding)
     SELECT
       '00000000-0000-0000-0000-0000000012' || LPAD(series::text, 2, '0'),
       $1,
       series,
       'cosine outside selective scope ' || series,
       $2,
       '[0,1,0,0]'
     FROM generate_series(1, 6) AS series`,
    [FILE_B, SET_ID]
  );
  await db.query(
    `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, embedding_set_id, embedding)
     VALUES
       ('00000000-0000-0000-0000-000000001301', $1, 10, 'l2 nearest', $3, '[1,0,0,0]'),
       ('00000000-0000-0000-0000-000000001302', $2, 10, 'l2 farther', $3, '[0,1,0,0]'),
       ('00000000-0000-0000-0000-000000001303', $1, 11, 'ip strongest', $4, '[2,0,0,0]'),
       ('00000000-0000-0000-0000-000000001304', $2, 11, 'ip weaker', $4, '[0.5,0,0,0]')`,
    [FILE_A, FILE_B, SET_L2, SET_IP]
  );
  await db.query('INSERT INTO selection_snapshots (id, created_at) VALUES ($1, NOW())', [
    SNAPSHOT_ID,
  ]);
  await db.query(
    `INSERT INTO selection_snapshots (id, created_at, expires_at)
     VALUES ($1, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
    [EXPIRED_SNAPSHOT_ID]
  );
  await db.query('INSERT INTO selection_snapshot_files (snapshot_id, file_path) VALUES ($1, $2)', [
    SNAPSHOT_ID,
    'src/alpha.ts',
  ]);
  await db.query('INSERT INTO selection_snapshot_files (snapshot_id, file_path) VALUES ($1, $2)', [
    EXPIRED_SNAPSHOT_ID,
    'src/alpha.ts',
  ]);
}

describe.each(ADAPTERS)('$name file-chunk search parity', ({ create }) => {
  let db: PGlite;
  let repository: IFileChunkRepository;

  beforeAll(async () => {
    db = await createMigratedTestDb();
    await seedSearchCorpus(db);
    repository = create(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it.each([
    ['rootIds', { rootIds: [ROOT_A] }],
    ['filePaths', { filePaths: [' src/alpha.ts ', 'src/alpha.ts'] }],
    ['selectionSnapshotId', { selectionSnapshotId: ` ${SNAPSHOT_ID} ` }],
  ] as const)('applies the supported %s vector scope', async (_scopeName, scope) => {
    const results = await repository.searchSimilar(QUERY_VECTOR, {
      embeddingSetId: SET_ID,
      includeEmbedding: false,
      limit: 10,
      threshold: 0,
      ...scope,
    });

    expect(results.map((result) => result.chunk.id)).toEqual([CHUNK_A]);
    expect(results[0]?.chunk).toMatchObject({
      chunkType: 'code',
      contentHash: 'alpha-hash',
      embeddingDimensions: 4,
      endLine: 14,
      startLine: 10,
    });
    expect(results[0]?.chunk.embedding).toBeUndefined();
  });

  it('returns the vector only when includeEmbedding is requested', async () => {
    const [result] = await repository.searchSimilar(QUERY_VECTOR, {
      embeddingSetId: SET_ID,
      includeEmbedding: true,
      limit: 1,
      rootIds: [ROOT_A],
      threshold: 0,
    });

    expect(result?.chunk.embedding).toEqual(QUERY_VECTOR);
    expect(result?.chunk.embeddingDimensions).toBe(4);
  });

  it('routes a selective filter over the exact full-precision path', async () => {
    // One root-A match among eight vectors is below the 15% exact-route cutoff.
    const results = await repository.searchSimilar(QUERY_VECTOR, {
      embeddingSetId: SET_ID,
      rootIds: [ROOT_A],
      threshold: 0,
    });

    expect(results.map((result) => result.chunk.id)).toEqual([CHUNK_A]);
    expect(results[0]?.similarity).toBeCloseTo(1, 6);
  });

  it.each([
    ['cosine', SET_ID, CHUNK_A],
    ['l2', SET_L2, '00000000-0000-0000-0000-000000001301'],
    ['ip', SET_IP, '00000000-0000-0000-0000-000000001303'],
  ] as const)('ranks the expected nearest chunk for %s distance', async (_distance, setId, id) => {
    const results = await repository.searchSimilar(QUERY_VECTOR, {
      embeddingSetId: setId,
      limit: 1,
      threshold: 0,
    });

    expect(results[0]?.chunk.id).toBe(id);
  });

  it.each([
    ['plain', 'authentication middleware'],
    ['phrase', 'authentication middleware'],
    ['websearch', 'authentication AND middleware'],
  ] as const)('preserves %s full-text mode and shared scopes', async (queryMode, query) => {
    const results = await repository.fullTextSearch(query, {
      filePaths: ['src/alpha.ts'],
      queryMode,
      rootIds: [ROOT_A],
      selectionSnapshotId: SNAPSHOT_ID,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ matchKind: 'exact' });
    expect(results[0]?.chunk.id).toBe(CHUNK_A);
  });

  it('uses the plain-mode fuzzy fallback for a typo', async () => {
    const results = await repository.fullTextSearch('authentcation', {
      queryMode: 'plain',
      rootIds: [ROOT_A],
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ matchKind: 'fuzzy' });
    expect(results[0]?.chunk.id).toBe(CHUNK_A);
  });

  it('treats an empty root allowlist as matching nothing', async () => {
    await expect(
      repository.searchSimilar(QUERY_VECTOR, {
        embeddingSetId: SET_ID,
        rootIds: [],
        threshold: 0,
      })
    ).resolves.toEqual([]);
    await expect(repository.fullTextSearch('authentication', { rootIds: [] })).resolves.toEqual([]);
  });

  it('preserves empty filePaths as an omitted filter', async () => {
    const vectorResults = await repository.searchSimilar(QUERY_VECTOR, {
      embeddingSetId: SET_ID,
      filePaths: [],
      threshold: 0,
    });
    const textResults = await repository.fullTextSearch('authentication OR authorization', {
      filePaths: [],
    });

    expect(vectorResults.map((result) => result.chunk.id)).toContain(CHUNK_A);
    expect(vectorResults.map((result) => result.chunk.id)).toContain(CHUNK_B);
    expect(textResults.map((result) => result.chunk.id).sort()).toEqual([CHUNK_A, CHUNK_B]);
  });

  it('composes simultaneous scopes with AND semantics', async () => {
    await expect(
      repository.searchSimilar(QUERY_VECTOR, {
        embeddingSetId: SET_ID,
        filePaths: ['src/beta.ts'],
        rootIds: [ROOT_A],
        threshold: 0,
      })
    ).resolves.toEqual([]);
    await expect(
      repository.fullTextSearch('authorization', {
        filePaths: ['src/beta.ts'],
        rootIds: [ROOT_A],
      })
    ).resolves.toEqual([]);
  });
});

describe('preserved expired-snapshot behavior', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedTestDb();
    await seedSearchCorpus(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it.each([
    ['raw PGlite', (database: PGlite): IFileChunkRepository => new FileChunkRepository(database)],
    ['Electron query bridge', createElectronRepository],
  ] as const)('%s rejects an expired selection snapshot', async (_name, create) => {
    const repository = create(db);
    await expect(
      repository.searchSimilar(QUERY_VECTOR, {
        embeddingSetId: SET_ID,
        selectionSnapshotId: EXPIRED_SNAPSHOT_ID,
      })
    ).resolves.toEqual([]);
  });

  it('Drizzle preserves its current snapshot-membership-only behavior', async () => {
    const repository: IFileChunkRepository = new DrizzleFileChunkRepository(drizzle(db));
    const results = await repository.searchSimilar(QUERY_VECTOR, {
      embeddingSetId: SET_ID,
      selectionSnapshotId: EXPIRED_SNAPSHOT_ID,
    });

    expect(results.map((result) => result.chunk.id)).toEqual([CHUNK_A]);
  });
});

describe('adapter-specific vector result ceiling', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedTestDb();
    await seedSearchCorpus(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it('keeps the Drizzle refusal while the raw adapter accepts the request', async () => {
    const raw: IFileChunkRepository = new FileChunkRepository(db);
    const drizzleRepository: IFileChunkRepository = new DrizzleFileChunkRepository(drizzle(db));
    const options = { embeddingSetId: SET_ID, limit: 2001, threshold: 0 };

    await expect(raw.searchSimilar(QUERY_VECTOR, options)).resolves.toHaveLength(8);
    await expect(drizzleRepository.searchSimilar(QUERY_VECTOR, options)).rejects.toThrow(
      'exceeds maximum allowed (2000)'
    );
  });
});
