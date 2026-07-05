import { expect } from 'vitest';
import type { BrainstrikeDbExecutionClient } from '../../src/architecture/brainstrike-db-client-contract.js';
import {
  applyTursoManagedCacheBatch,
  invalidateTursoManagedCacheEntriesByIdentity,
} from '../../src/managed-cache/index.js';
import type { FileChunkInsert } from '../../src/models/file-chunk.js';
import type { FileRecord } from '../../src/models/file-record.js';
import { TursoJobQueue } from '../../src/queue/turso-job-queue.js';
import type { TokenCacheEntry } from '../../src/repositories/token-cache-store-types.js';
import { TursoEmbeddingSetsRepository } from '../../src/repositories/turso-embedding-sets-repository.js';
import { TursoFileChunkRepository } from '../../src/repositories/turso-file-chunk-repository.js';
import { TursoFileRecordRepository } from '../../src/repositories/turso-file-record-repository.js';
import { TursoTokenCacheStore } from '../../src/repositories/turso-token-cache-store.js';
import { TursoViewFilterPresetsRepository } from '../../src/repositories/turso-view-filter-presets-repository.js';
import {
  markTursoCollectionIndexingStatsDirty,
  refreshTursoCollectionIndexingStats,
} from '../../src/services/turso-collection-indexing-stats.js';

/**
 * Shared Turso repository CONTRACT bodies for the runtime parity lane (A6).
 *
 * Each exported `run*Contract` function executes the SAME row-level assertions
 * against any `BrainstrikeDbExecutionClient`, so the node lane (native Turso
 * owner client, `turso-runtime-parity.test.ts`) and the browser lane (real
 * `@tursodatabase/database-wasm` FIFO client over OPFS,
 * `turso-browser-runtime-parity.browser.test.ts`) prove identical repository
 * behavior. The bodies are distilled from the stable node suites
 * (turso-*-repository / job-queue-turso-runtime / turso-managed-cache-batch);
 * those suites keep their deeper dialect/SQL-shape coverage.
 *
 * CONTRACT vs RUNTIME:
 * - Contract (asserted here): row-level results, effective embedding-set
 *   membership (explicit chunk set id wins, NULL inherits from file_records),
 *   lease-token queue lifecycle, stats refresh values, gram/vector search
 *   results, validation failures.
 * - Runtime (deliberately NOT asserted): transaction concurrency model
 *   (BEGIN CONCURRENT vs single-writer FIFO), journal mode, timings, SQL
 *   plan/dialect shapes, and raw-SQL integer typing at the driver boundary
 *   (raw reads below normalize via Number(); repository APIs must return
 *   plain numbers and are asserted exactly).
 */

const PARITY_TABLE_DELETE_ORDER = [
  'job_queue',
  'selection_snapshot_files',
  'selection_snapshots',
  'file_chunk_content_grams',
  'file_chunk_content_index',
  'file_chunks',
  'file_record_name_grams',
  'file_record_name_index',
  'file_records',
  'collection_indexing_stats',
  'embedding_sets',
  'file_token_cache',
  'roots',
] as const;

/**
 * Returns the database to the post-baseline state so contracts can share one
 * open store (the browser lane opens OPFS once for the whole suite). Seeded
 * default view filter presets are preserved — the presets contract asserts
 * them.
 */
export async function resetTursoParityTables(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  for (const table of PARITY_TABLE_DELETE_ORDER) {
    await client.exec(`DELETE FROM ${table}`);
  }
  await client.exec('DELETE FROM view_filter_presets WHERE is_default = 0');
}

export async function runEmbeddingSetsCrudAndStatsSeedContract(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  const repository = new TursoEmbeddingSetsRepository(client);

  // Duplicate-capable user sets seed zeroed indexing stats rows.
  const first = await repository.getOrCreateSet(
    'openai:text-embedding-3-small',
    'text-embedding-3-small',
    1536,
    'cosine',
    { name: 'Semantic Search', tags: 'search,openai' }
  );
  const second = await repository.getOrCreateSet(
    'openai:text-embedding-3-small',
    'text-embedding-3-small',
    1536,
    'cosine'
  );
  expect(first.id).not.toBe(second.id);
  expect(first).toMatchObject({
    dimensions: 1536,
    distance: 'cosine',
    modelId: 'text-embedding-3-small',
    modelKey: 'openai::text-embedding-3-small',
    name: 'Semantic Search',
    tags: 'search,openai',
  });
  expect(second.name).toBe('text-embedding-3-small (1536D)');
  for (const setId of [first.id, second.id]) {
    await expect(readCollectionStats(client, setId)).resolves.toMatchObject({
      chunk_count: 0,
      dirty: 0,
      embedded_chunk_count: 0,
      file_count: 0,
      pending_chunk_count: 0,
    });
  }

  // Exactly one protected workspace index set.
  const workspaceFirst = await repository.getOrCreateWorkspaceIndexSet();
  const workspaceSecond = await repository.getOrCreateWorkspaceIndexSet();
  expect(workspaceSecond.id).toBe(workspaceFirst.id);
  expect(workspaceFirst).toMatchObject({
    dimensions: 384,
    distance: 'cosine',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    modelKey: 'local::Xenova/all-MiniLM-L6-v2',
    name: 'Workspace Index',
    systemRole: 'workspace-index',
  });

  // Find / update metadata / delete round trip.
  const created = await repository.getOrCreateSet('voyage:voyage-3-lite', 'voyage-3-lite', 512, 'l2');
  await expect(repository.getById(created.id)).resolves.toMatchObject({
    id: created.id,
    modelKey: 'voyage::voyage-3-lite',
  });
  await expect(repository.getByModelKey('voyage:voyage-3-lite')).resolves.toHaveLength(1);
  await expect(
    repository.updateMetadata(created.id, {
      category: 'general-text',
      description: 'Updated description',
      name: 'Updated Name',
    })
  ).resolves.toMatchObject({
    category: 'general-text',
    description: 'Updated description',
    name: 'Updated Name',
  });
  await expect(repository.delete(created.id)).resolves.toBe(true);
  await expect(repository.getById(created.id)).resolves.toBeNull();
  await expect(repository.findAll()).resolves.toHaveLength(3);
}

export async function runFileRecordPersistenceContract(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  const repository = new TursoFileRecordRepository(client);

  const record = createParityRecord({
    content: 'const answer = 42;',
    contentHash: 'hash-answer',
    embeddingSetId: 'set-a',
    processedAt: '2026-06-23T07:00:00.000Z',
    tokenCount: 5,
  });
  await repository.createWithContent(record);
  await expect(repository.findById(record.id)).resolves.toMatchObject({
    content: 'const answer = 42;',
    contentHash: 'hash-answer',
    embeddingSetId: 'set-a',
    id: record.id,
    tokenCount: 5,
  });
  await expect(repository.findByContentHash('hash-answer')).resolves.toMatchObject({
    id: record.id,
  });
  await expect(repository.findByIds([record.id, record.id, 'missing'])).resolves.toHaveLength(1);
  await expect(repository.count()).resolves.toBe(1);
  await expect(repository.countWithContent()).resolves.toBe(1);

  // Nullable metadata update + content replacement.
  await repository.update(record.id, {
    chunkingStrategy: 'markdown',
    chunksCount: 3,
    chunksProcessedAt: '2026-06-23T07:01:00.000Z',
    content: null,
    contentHash: null,
    embeddingSetId: null,
    processedAt: null,
    tokenCount: null,
  });
  await repository.updateContent(record.id, 'updated', 'new-hash', 2);
  await expect(repository.findById(record.id)).resolves.toMatchObject({
    chunkingStrategy: 'markdown',
    chunksCount: 3,
    chunksProcessedAt: '2026-06-23T07:01:00.000Z',
    content: 'updated',
    contentHash: 'new-hash',
    tokenCount: 2,
  });

  // Validation failures leave rows untouched.
  await expect(repository.update(record.id, { updatedAt: 'not-a-date' })).rejects.toThrow(
    'Invalid file record updatedAt date: not-a-date'
  );
  await expect(
    repository.createWithContent(
      createParityRecord({
        content: `valid-prefix${String.fromCharCode(0)}invalid`,
        contentHash: 'null-byte',
        id: 'null-byte-record',
        path: 'src/null-byte.ts',
      })
    )
  ).rejects.toThrow('File record content cannot contain null bytes.');
  await expect(repository.count()).resolves.toBe(1);

  // Bulk import dedupes by content hash within one embedding set.
  const shared = 'const shared = true;';
  await expect(
    repository.bulkImport([
      { content: shared, embeddingSetId: 'set-a', name: 'a.ts', path: 'src/a.ts', size: 10 },
      { content: shared, embeddingSetId: 'set-a', name: 'a-copy.ts', path: 'src/a-copy.ts', size: 10 },
      { content: shared, embeddingSetId: 'set-b', name: 'b.ts', path: 'src/b.ts', size: 10 },
    ])
  ).resolves.toEqual([
    expect.objectContaining({ existed: false, imported: true }),
    expect.objectContaining({ existed: true, imported: false }),
    expect.objectContaining({ existed: false, imported: true }),
  ]);
  await expect(repository.count()).resolves.toBe(3);

  // Delete + clearAll report row counts.
  await repository.delete(record.id);
  await expect(repository.findById(record.id)).resolves.toBeNull();
  await expect(repository.clearAll()).resolves.toBe(2);
  await expect(repository.count()).resolves.toBe(0);
}

export async function runManagedCacheIdentityContract(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  const repository = new TursoFileRecordRepository(client);
  await seedParityRoot(client, 'root-a', 'Root A');
  const record = createParityRecord({
    content: 'export const value = 1;',
    contentHash: 'hash-managed',
    embeddingSetId: 'set-managed',
    id: 'managed-record',
    path: 'src/index.ts',
  });
  await repository.createWithContent(record);
  await client.exec('UPDATE file_records SET root_id = ? WHERE id = ?', ['root-a', record.id]);

  await expect(
    repository.findByManagedCacheIdentity('set-managed', 'root-a', 'src/index.ts')
  ).resolves.toMatchObject({ id: record.id });

  await repository.updateStatMetadata([{ fileRecordId: record.id, mtimeMs: 1234.9, size: 88 }]);
  await expect(repository.listManagedCacheEntryMetadata('set-managed')).resolves.toEqual([
    expect.objectContaining({
      contentHash: 'hash-managed',
      fileRecordId: record.id,
      mtimeMs: 1234,
      relativePath: 'src/index.ts',
      rootId: 'root-a',
      size: 88,
    }),
  ]);
}

export async function runFileChunkPersistenceContract(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  const fileRecords = new TursoFileRecordRepository(client);
  const repository = new TursoFileChunkRepository(client);
  await fileRecords.createWithContent(createParityRecord({ id: 'file-1' }));
  await fileRecords.createWithContent(createParityRecord({ id: 'file-2', path: 'src/two.ts' }));

  // Insert + id-upsert semantics: re-inserting an existing id updates content
  // fields but keeps the original chunk position and file ownership.
  await expect(repository.insert(createParityChunk({ id: 'chunk-1' }))).resolves.toMatchObject({
    chunkIndex: 0,
    content: 'const answer = 42;',
    contentHash: 'hash-chunk-1',
    fileRecordId: 'file-1',
    id: 'chunk-1',
  });
  await repository.insert(
    createParityChunk({
      chunkIndex: 9,
      chunkSize: 24,
      content: 'const answer = 43;',
      contentHash: 'hash-chunk-1-updated',
      fileRecordId: 'file-2',
      id: 'chunk-1',
      tokenCount: 5,
      updatedAt: '2026-06-23T08:30:00.000Z',
    })
  );
  await repository.insert(createParityChunk({ chunkIndex: 1, id: 'chunk-2' }));
  await expect(repository.findById('chunk-1')).resolves.toMatchObject({
    chunkIndex: 0,
    chunkSize: 24,
    content: 'const answer = 43;',
    contentHash: 'hash-chunk-1-updated',
    fileRecordId: 'file-1',
    tokenCount: 5,
    updatedAt: '2026-06-23T08:30:00.000Z',
  });
  await expect(repository.findByFileRecordId('file-1')).resolves.toEqual([
    expect.objectContaining({ id: 'chunk-1' }),
    expect.objectContaining({ id: 'chunk-2' }),
  ]);

  // Batch inserts are atomic and reject null bytes before writing.
  await repository.deleteByFileRecordId('file-1');
  await expect(
    repository.insertMany([
      createParityChunk({ chunkIndex: 0, id: 'chunk-1' }),
      createParityChunk({
        chunkIndex: 1,
        content: `valid-prefix${String.fromCharCode(0)}invalid`,
        id: 'chunk-2',
      }),
    ])
  ).rejects.toThrow('File chunk content cannot contain null bytes.');
  await expect(repository.findByFileRecordId('file-1')).resolves.toEqual([]);
  await expect(
    repository.insertMany([
      createParityChunk({ chunkIndex: 1, id: 'chunk-2' }),
      createParityChunk({ chunkIndex: 0, id: 'chunk-1' }),
    ])
  ).resolves.toHaveLength(2);

  // Update round trip with embedding payload + dimension validation.
  const embeddingSets = new TursoEmbeddingSetsRepository(client);
  const embeddingSet = await embeddingSets.getOrCreateSet('test:small', 'small', 3, 'cosine');
  await expect(
    repository.update({
      chunkSize: 19,
      content: 'const updated = true;',
      contentHash: 'hash-updated',
      embedding: [0.1, 0.2, 0.3],
      embeddingHash: 'embedding-hash',
      embeddingSetId: embeddingSet.id,
      embeddingUpdatedAt: '2026-06-23T08:45:00.000Z',
      endLine: 7,
      id: 'chunk-1',
      startLine: 4,
      tokenCount: 6,
      updatedAt: '2026-06-23T08:45:00.000Z',
    })
  ).resolves.toMatchObject({
    chunkSize: 19,
    content: 'const updated = true;',
    embedding: [0.1, 0.2, 0.3],
    embeddingDimensions: 3,
    embeddingHash: 'embedding-hash',
    embeddingSetId: embeddingSet.id,
    embeddingUpdatedAt: '2026-06-23T08:45:00.000Z',
    endLine: 7,
    startLine: 4,
  });
  await expect(
    repository.update({
      embedding: [0.1, 0.2],
      embeddingSetId: embeddingSet.id,
      id: 'chunk-1',
      updatedAt: '2026-06-23T08:46:00.000Z',
    })
  ).rejects.toThrow('Embedding dimension mismatch: received 2, expected 3.');
  await expect(repository.findById('chunk-1')).resolves.toMatchObject({
    embedding: [0.1, 0.2, 0.3],
    updatedAt: '2026-06-23T08:45:00.000Z',
  });

  // Delete semantics.
  await expect(repository.delete('chunk-1')).resolves.toBe(true);
  await expect(repository.findById('chunk-1')).resolves.toBeNull();
  await expect(repository.deleteByFileRecordId('file-1')).resolves.toBe(1);
  await expect(repository.findByFileRecordId('file-1')).resolves.toEqual([]);
}

export async function runEffectiveMembershipContract(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  const embeddingSets = new TursoEmbeddingSetsRepository(client);
  const fileRecords = new TursoFileRecordRepository(client);
  const repository = new TursoFileChunkRepository(client);
  const setA = await embeddingSets.getOrCreateSet('test:small', 'small', 3, 'cosine');
  const setB = await embeddingSets.getOrCreateSet('test:other', 'other', 3, 'cosine');
  await fileRecords.createWithContent(
    createParityRecord({ embeddingSetId: setA.id, id: 'file-1' })
  );
  await fileRecords.createWithContent(
    createParityRecord({ id: 'file-direct-only', path: 'src/direct-only.ts' })
  );

  await repository.insertMany([
    // Explicit membership in set A.
    createParityChunk({
      chunkIndex: 0,
      embedding: [0.1, 0.2, 0.3],
      embeddingSetId: setA.id,
      id: 'chunk-explicit-a',
      tokenCount: 5,
    }),
    // NULL set id inherits set A from file-1.
    createParityChunk({
      chunkIndex: 1,
      embedding: [0.3, 0.2, 0.1],
      id: 'chunk-inherited',
      tokenCount: 7,
    }),
    // Explicit membership in set B under a set-A file: explicit wins.
    createParityChunk({
      chunkIndex: 2,
      embedding: [0.2, 0.2, 0.2],
      embeddingSetId: setB.id,
      id: 'chunk-explicit-b',
      tokenCount: 3,
    }),
    // Explicit membership in set A under a file with no set assignment.
    createParityChunk({
      chunkIndex: 0,
      embedding: [0.4, 0.5, 0.6],
      embeddingSetId: setA.id,
      fileRecordId: 'file-direct-only',
      id: 'chunk-direct-under-unassigned-file',
      tokenCount: 11,
    }),
  ]);

  await expect(repository.getCoverageForSet(setA.id)).resolves.toEqual({
    chunksWithEmbeddingsForSet: 3,
    totalChunks: 3,
  });
  await expect(repository.getCoverageForSet(setB.id)).resolves.toEqual({
    chunksWithEmbeddingsForSet: 1,
    totalChunks: 1,
  });

  // Clearing set A strips embeddings from explicit-A and inherited chunks only.
  await expect(repository.clearEmbeddingsForSet(setA.id)).resolves.toBe(3);
  const clearedExplicit = await repository.findById('chunk-explicit-a');
  expect(clearedExplicit).toMatchObject({ embeddingSetId: setA.id });
  expect(clearedExplicit).not.toHaveProperty('embedding');
  expect(clearedExplicit).not.toHaveProperty('embeddingHash');
  expect(clearedExplicit).not.toHaveProperty('embeddingUpdatedAt');
  const clearedInherited = await repository.findById('chunk-inherited');
  expect(clearedInherited).toMatchObject({ id: 'chunk-inherited' });
  expect(clearedInherited).not.toHaveProperty('embeddingSetId');
  expect(clearedInherited).not.toHaveProperty('embedding');
  expect(clearedInherited).not.toHaveProperty('embeddingHash');
  expect(clearedInherited).not.toHaveProperty('embeddingUpdatedAt');
  await expect(repository.findById('chunk-explicit-b')).resolves.toMatchObject({
    embedding: [0.2, 0.2, 0.2],
    embeddingSetId: setB.id,
  });

  // clearEmbeddingsForSet refreshes the stats row with inherited ownership.
  await expect(readCollectionStats(client, setA.id)).resolves.toMatchObject({
    chunk_count: 3,
    dirty: 0,
    embedded_chunk_count: 0,
    file_count: 1,
    pending_chunk_count: 3,
  });

  // Missing sets fail closed instead of clearing legacy chunks.
  await expect(repository.clearEmbeddingsForSet('missing-set')).rejects.toThrow(
    "Embedding set 'missing-set' does not exist."
  );
}

export async function runQuickOpenNameGramContract(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  const repository = new TursoFileRecordRepository(client);
  await seedParityRoot(client, 'root-a', 'Alpha');
  await seedParityRoot(client, 'root-b', 'Beta');
  await repository.create(
    createParityRecord({ id: 'long', name: 'alphabet.ts', path: 'src/z.ts' })
  );
  await repository.create(createParityRecord({ id: 'short', name: 'alpha.ts', path: 'src/a.ts' }));
  await repository.create(
    createParityRecord({ id: 'beta', name: 'AlphaBeta.ts', path: 'src/b.ts' })
  );
  await repository.create(
    createParityRecord({ id: 'legacy', name: 'alpha.md', path: 'docs/alpha.md' })
  );
  await repository.create(
    createParityRecord({ id: 'accented', name: 'Éclair.ts', path: 'src/eclair.ts' })
  );
  await repository.create(
    createParityRecord({ id: 'unmatched', name: 'readme.md', path: 'docs/readme.md' })
  );
  await client.exec('UPDATE file_records SET root_id = ? WHERE id = ?', ['root-a', 'long']);
  await client.exec('UPDATE file_records SET root_id = ? WHERE id = ?', ['root-a', 'short']);
  await client.exec('UPDATE file_records SET root_id = ? WHERE id = ?', ['root-b', 'beta']);

  await expect(repository.findByNameSubstring('ALPHA', 2)).resolves.toEqual([
    { display_name: null, id: 'legacy', name: 'alpha.md', path: 'docs/alpha.md', root_id: null },
    { display_name: 'Alpha', id: 'short', name: 'alpha.ts', path: 'src/a.ts', root_id: 'root-a' },
  ]);
  await expect(repository.findByNameSubstring('écl', 50)).resolves.toEqual([
    { display_name: null, id: 'accented', name: 'Éclair.ts', path: 'src/eclair.ts', root_id: null },
  ]);

  // Grams stay consistent across renames, deletes, and clears.
  await repository.update('short', { name: 'renamed.ts' });
  await expect(repository.findByNameSubstring('alpha', 50)).resolves.toEqual([
    expect.objectContaining({ id: 'legacy' }),
    expect.objectContaining({ id: 'long' }),
    expect.objectContaining({ id: 'beta' }),
  ]);
  await repository.delete('legacy');
  await expect(repository.findByNameSubstring('alpha', 50)).resolves.toEqual([
    expect.objectContaining({ id: 'long' }),
    expect.objectContaining({ id: 'beta' }),
  ]);
  await repository.clearAll();
  await expect(repository.findByNameSubstring('alpha', 50)).resolves.toEqual([]);
}

export async function runGrepCandidatesContract(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  const fileRecords = new TursoFileRecordRepository(client);
  const repository = new TursoFileChunkRepository(client);
  await seedParityRoot(client, 'root-a', 'Root A');
  await seedParityRoot(client, 'root-b', 'Root B');
  await fileRecords.createWithContent(
    createParityRecord({ embeddingSetId: 'set-a', id: 'file-a', name: 'alpha.ts', path: 'src/alpha.ts' })
  );
  await fileRecords.createWithContent(
    createParityRecord({ id: 'file-b', name: 'beta.ts', path: 'src/beta.ts' })
  );
  await fileRecords.createWithContent(
    createParityRecord({ id: 'file-c', name: 'gamma.ts', path: 'src/gamma.ts' })
  );
  await client.exec('UPDATE file_records SET root_id = ? WHERE id = ?', ['root-a', 'file-a']);
  await client.exec('UPDATE file_records SET root_id = ? WHERE id = ?', ['root-b', 'file-b']);
  await client.exec('UPDATE file_records SET root_id = ? WHERE id = ?', ['root-a', 'file-c']);
  await repository.insertMany([
    createParityChunk({
      chunkIndex: 1,
      content: 'const answer = 42;\nconst answerAgain = answer;',
      fileRecordId: 'file-a',
      id: 'chunk-a',
      startLine: 10,
    }),
    createParityChunk({
      content: 'const Answer = 99;',
      embeddingSetId: 'set-a',
      fileRecordId: 'file-b',
      id: 'chunk-b',
      startLine: 3,
    }),
    createParityChunk({
      content: 'const answer = 100;',
      embeddingSetId: 'set-b',
      fileRecordId: 'file-c',
      id: 'chunk-c',
      startLine: 1,
    }),
    createParityChunk({
      chunkIndex: 2,
      content: 'const percent = "100%_done";',
      embeddingSetId: 'set-a',
      fileRecordId: 'file-a',
      id: 'chunk-d',
      startLine: 20,
    }),
  ]);

  await expect(
    repository.findGrepCandidates({
      caseSensitive: false,
      embeddingSetId: 'set-a',
      filePaths: ['src/beta.ts', 'src/alpha.ts'],
      likePattern: 'answer',
      limit: 10,
      rootId: 'root-a',
    })
  ).resolves.toEqual([
    {
      content: 'const answer = 42;\nconst answerAgain = answer;',
      filePath: 'src/alpha.ts',
      rootId: 'root-a',
      rootName: 'Root A',
      startLine: 10,
    },
  ]);
  await expect(
    repository.findGrepCandidates({ caseSensitive: true, likePattern: 'answer', limit: 10 })
  ).resolves.toEqual([
    expect.objectContaining({ filePath: 'src/alpha.ts' }),
    expect.objectContaining({ filePath: 'src/gamma.ts' }),
  ]);
  await expect(
    repository.findGrepCandidates({ caseSensitive: false, likePattern: 'answer', limit: 1 })
  ).resolves.toHaveLength(1);
  await expect(
    repository.findGrepCandidates({
      caseSensitive: false,
      likePattern: '100\\%\\_done',
      limit: 10,
    })
  ).resolves.toEqual([expect.objectContaining({ filePath: 'src/alpha.ts', startLine: 20 })]);
  await expect(
    repository.findGrepCandidates({
      caseSensitive: false,
      filePaths: [],
      likePattern: 'answer',
      limit: 10,
    })
  ).resolves.toEqual([]);
}

export async function runVectorSearchContract(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  const embeddingSets = new TursoEmbeddingSetsRepository(client);
  const fileRecords = new TursoFileRecordRepository(client);
  const repository = new TursoFileChunkRepository(client);
  const embeddingSet = await embeddingSets.getOrCreateSet('test:small', 'small', 3, 'cosine');
  const otherEmbeddingSet = await embeddingSets.getOrCreateSet('test:other', 'other', 3, 'cosine');
  await seedParityRoot(client, 'root-a', 'Root A');
  await seedParityRoot(client, 'root-b', 'Root B');
  await fileRecords.createWithContent(
    createParityRecord({ embeddingSetId: embeddingSet.id, id: 'file-a', path: 'src/alpha.ts' })
  );
  await fileRecords.createWithContent(
    createParityRecord({ embeddingSetId: embeddingSet.id, id: 'file-b', path: 'src/beta.ts' })
  );
  await fileRecords.createWithContent(
    createParityRecord({ embeddingSetId: embeddingSet.id, id: 'file-c', path: 'src/gamma.ts' })
  );
  await client.exec('UPDATE file_records SET root_id = ? WHERE id IN (?, ?)', [
    'root-a',
    'file-a',
    'file-b',
  ]);
  await client.exec('UPDATE file_records SET root_id = ? WHERE id = ?', ['root-b', 'file-c']);
  await repository.insertMany([
    createParityChunk({
      chunkIndex: 0,
      content: 'near',
      embedding: [1, 0, 0],
      embeddingSetId: embeddingSet.id,
      fileRecordId: 'file-a',
      id: 'chunk-near',
    }),
    // NULL set id: effective membership inherited from file-b.
    createParityChunk({
      chunkIndex: 0,
      content: 'mid',
      embedding: [0.8, 0.6, 0],
      fileRecordId: 'file-b',
      id: 'chunk-mid',
    }),
    createParityChunk({
      chunkIndex: 1,
      content: 'far',
      embedding: [0, 1, 0],
      embeddingSetId: embeddingSet.id,
      fileRecordId: 'file-b',
      id: 'chunk-far',
    }),
    createParityChunk({
      chunkIndex: 2,
      content: 'opposite',
      embedding: [-1, 0, 0],
      embeddingSetId: embeddingSet.id,
      fileRecordId: 'file-b',
      id: 'chunk-opposite',
    }),
    createParityChunk({
      chunkIndex: 0,
      content: 'wrong root',
      embedding: [0.99, 0.1, 0],
      embeddingSetId: embeddingSet.id,
      fileRecordId: 'file-c',
      id: 'chunk-wrong-root',
    }),
    createParityChunk({
      chunkIndex: 1,
      content: 'wrong set',
      embedding: [1, 0, 0],
      embeddingSetId: otherEmbeddingSet.id,
      fileRecordId: 'file-a',
      id: 'chunk-wrong-set',
    }),
    createParityChunk({
      chunkIndex: 2,
      content: 'pending',
      embeddingSetId: embeddingSet.id,
      fileRecordId: 'file-a',
      id: 'chunk-pending',
    }),
  ]);

  await expect(
    repository.searchSimilar([1, 0, 0], {
      embeddingSetId: embeddingSet.id,
      limit: 2,
      rootId: 'root-a',
      threshold: 0.75,
    })
  ).resolves.toEqual([
    {
      chunk: expect.objectContaining({
        embeddingDimensions: 3,
        embeddingSetId: embeddingSet.id,
        id: 'chunk-near',
      }),
      rank: 1,
      similarity: expect.closeTo(1, 6),
    },
    {
      chunk: expect.objectContaining({ embeddingDimensions: 3, id: 'chunk-mid' }),
      rank: 2,
      similarity: expect.closeTo(0.9, 6),
    },
  ]);

  await client.exec(
    `INSERT INTO selection_snapshots (id, created_at, expires_at) VALUES (?, ?, ?)`,
    ['selection-beta', '2026-06-23T07:00:00.000Z', '2999-01-01T00:00:00.000Z']
  );
  await client.exec(
    `INSERT INTO selection_snapshot_files (snapshot_id, file_path) VALUES (?, ?)`,
    ['selection-beta', 'src/beta.ts']
  );
  const ranked = await repository.searchSimilar([1, 0, 0], {
    embeddingSetId: embeddingSet.id,
    filePaths: ['src/beta.ts'],
    includeEmbedding: true,
    limit: 5,
    selectionSnapshotId: 'selection-beta',
    threshold: 0.5,
  });
  expect(ranked.map((result) => result.chunk.id)).toEqual(['chunk-mid', 'chunk-far']);
  expect(ranked[0]?.chunk.embedding).toEqual([0.8, 0.6, 0]);
  expect(ranked[0]?.similarity).toEqual(expect.closeTo(0.9, 6));
  expect(ranked[1]?.similarity).toEqual(expect.closeTo(0.5, 6));

  await expect(
    repository.searchSimilar([1, 0], { embeddingSetId: embeddingSet.id })
  ).rejects.toThrow(
    `Query embedding dimension mismatch: received 2, expected 3 for embedding set ${embeddingSet.id}.`
  );
}

export async function runViewFilterPresetsContract(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  const repository = new TursoViewFilterPresetsRepository(client);

  const defaults = await repository.getDefaults();
  expect(defaults).toHaveLength(7);
  expect(defaults[0]).toMatchObject({
    id: 'typescript-javascript',
    includes: ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'],
    isDefault: true,
    useRegex: false,
  });

  const created = await repository.create({
    description: 'Docs and notes',
    excludes: ['node_modules', 'dist'],
    icon: 'file-text',
    includes: ['*.md', '*.mdx'],
    name: 'Docs',
    useRegex: true,
  });
  expect(created).toMatchObject({
    description: 'Docs and notes',
    excludes: ['node_modules', 'dist'],
    icon: 'file-text',
    includes: ['*.md', '*.mdx'],
    isDefault: false,
    name: 'Docs',
    useRegex: true,
  });
  await expect(
    repository.update(created.id, {
      excludes: ['coverage'],
      includes: ['*.md'],
      name: 'Markdown',
      sortOrder: 42,
      useRegex: false,
    })
  ).resolves.toMatchObject({
    excludes: ['coverage'],
    includes: ['*.md'],
    name: 'Markdown',
    sortOrder: 42,
    useRegex: false,
  });
  await expect(repository.delete(created.id)).resolves.toBe(true);
  await expect(repository.getById(created.id)).resolves.toBeNull();

  // Seeded defaults refuse deletion.
  await expect(repository.delete('typescript-javascript')).resolves.toBe(false);
  await expect(repository.getById('typescript-javascript')).resolves.not.toBeNull();
}

export async function runTokenCacheContract(client: BrainstrikeDbExecutionClient): Promise<void> {
  const folderId = 'parity-folder-001';
  const store = new TursoTokenCacheStore(client);
  const createEntry = (overrides: Partial<TokenCacheEntry> = {}): TokenCacheEntry => ({
    contentHash: 'abc123',
    countingMode: 'accurate',
    createdAt: '2026-06-23T12:00:00.000Z',
    filePath: 'src/test.ts',
    fileSize: 1024,
    folderId,
    modelEncoding: 'o200k_base',
    mtimeMs: 1_750_000_000_000,
    tokenCount: 100,
    updatedAt: '2026-06-23T12:00:00.000Z',
    ...overrides,
  });

  // Upsert wins with the latest write.
  await store.set(createEntry({ filePath: 'src/file.ts', tokenCount: 100 }));
  await store.set(createEntry({ filePath: 'src/file.ts', tokenCount: 200 }));
  await expect(store.get(folderId, 'src/file.ts')).resolves.toMatchObject({
    countingMode: 'accurate',
    filePath: 'src/file.ts',
    tokenCount: 200,
  });

  // Batch lookup, totals, stats, counting-mode queries.
  await store.setBatch([
    createEntry({ filePath: 'src/a.ts', tokenCount: 100 }),
    createEntry({ countingMode: 'heuristic', filePath: 'src/b.ts', tokenCount: 200 }),
    createEntry({ countingMode: 'heuristic', filePath: 'src/c.ts', tokenCount: 300 }),
  ]);
  const batch = await store.getBatch(folderId, ['src/a.ts', 'src/c.ts']);
  expect([...batch.keys()]).toEqual(['src/a.ts', 'src/c.ts']);
  await expect(store.getTotalTokens(folderId, ['src/a.ts', 'src/b.ts'])).resolves.toBe(300);
  await expect(store.getStats(folderId)).resolves.toMatchObject({
    accurateCount: 2,
    entryCount: 4,
    heuristicCount: 2,
    totalTokens: 800,
  });
  await expect(store.findByCountingMode(folderId, 'heuristic', 1)).resolves.toHaveLength(1);

  // Large lookups stay under the SQLite parameter budget and return rows.
  const manyPaths = Array.from(
    { length: 1200 },
    (_, index) => `src/many-${String(index).padStart(4, '0')}.ts`
  );
  manyPaths.push('src/a.ts');
  const chunkedBatch = await store.getBatch(folderId, manyPaths);
  expect([...chunkedBatch.keys()]).toEqual(['src/a.ts']);

  // Folder-scoped deletes never cross folder boundaries.
  await store.set(createEntry({ filePath: 'src/other.ts', folderId: 'other-folder' }));
  await expect(store.delete(folderId, 'src/a.ts')).resolves.toBe(true);
  await expect(store.delete(folderId, 'src/missing.ts')).resolves.toBe(false);
  await expect(store.clearFolder(folderId)).resolves.toBe(3);
  await expect(store.getAllForFolder('other-folder')).resolves.toHaveLength(1);
  await expect(store.clearAll()).resolves.toBe(1);

  // Unsafe relative paths fail closed before any row is written.
  await expect(
    store.setBatch([
      createEntry({ filePath: 'src/valid.ts' }),
      createEntry({ filePath: '../escape.ts' }),
    ])
  ).rejects.toThrow('Token cache file path must not contain relative traversal segments');
  await expect(store.getAllForFolder(folderId)).resolves.toHaveLength(0);
}

export async function runJobQueueLifecycleContract(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  const embeddingSets = new TursoEmbeddingSetsRepository(client);
  const fileRecords = new TursoFileRecordRepository(client);
  const chunkRepository = new TursoFileChunkRepository(client);
  const queue = new TursoJobQueue(client);
  const embeddingSet = await embeddingSets.getOrCreateSet(
    'local::parity-model',
    'parity-model',
    3,
    'cosine'
  );
  await fileRecords.createWithContent(
    createParityRecord({ embeddingSetId: embeddingSet.id, id: 'file-1' })
  );
  await chunkRepository.insert(createParityChunk({ embeddingSetId: embeddingSet.id }));

  // Enqueue projects chunk/set metadata and starts queued.
  const job = await queue.enqueue({
    dedupeKey: `chunk-1:${embeddingSet.id}:hash-chunk-1`,
    jobType: 'embed_chunk',
    payload: { chunkId: 'chunk-1', embeddingSetId: embeddingSet.id },
    queue: 'embeddings',
    runAt: '2026-06-23T08:00:00.000Z',
  });
  expect(job.state).toBe('queued');
  expect(job.chunk_id).toBe('chunk-1');
  expect(job.embedding_set_id).toBe(embeddingSet.id);

  // Claim takes a lease token and marks the job running.
  const [claimed] = await queue.claimMany({
    leaseMs: 1000,
    limit: 2,
    now: '2026-06-23T09:00:00.000Z',
    queue: 'embeddings',
    workerId: 'worker-a',
  });
  if (!claimed?.lease_token) {
    throw new Error('Expected the claimed parity job to carry a lease token.');
  }
  expect(claimed).toMatchObject({
    attempts: 1,
    id: job.id,
    state: 'running',
    worker_id: 'worker-a',
  });

  // Heartbeat extends the owned lease.
  const heartbeat = await queue.heartbeat({
    extendMs: 10_000,
    id: job.id,
    leaseToken: claimed.lease_token,
  });
  expect(heartbeat?.id).toBe(job.id);
  expect(heartbeat?.leasedUntil).toBeTruthy();

  // Fail requeues with backoff and clears the lease.
  const failed = await queue.fail({
    backoffMs: 50,
    error: 'model unavailable',
    id: job.id,
    leaseToken: claimed.lease_token,
  });
  expect(failed).toMatchObject({ attempts: 1, id: job.id, state: 'queued' });
  expect(failed?.lease_token).toBeNull();
  await expect(queue.getQueueStats('embeddings')).resolves.toEqual([
    expect.objectContaining({
      failed: 0,
      queue: 'embeddings',
      queued: 1,
      running: 0,
      succeeded: 0,
    }),
  ]);

  // Retry: a later claim picks the job back up with a fresh lease.
  const [reclaimed] = await queue.claimMany({
    leaseMs: 60_000,
    limit: 1,
    now: '2999-01-01T00:00:00.000Z',
    queue: 'embeddings',
    workerId: 'worker-b',
  });
  if (!reclaimed?.lease_token) {
    throw new Error('Expected the reclaimed parity job to carry a lease token.');
  }
  expect(reclaimed).toMatchObject({ attempts: 2, id: job.id, state: 'running' });
  expect(reclaimed.lease_token).not.toBe(claimed.lease_token);

  // Complete writes the chunk embedding and finishes the owned lease.
  const completed = await queue.completeEmbeddingChunkBatch([
    {
      chunkId: 'chunk-1',
      embedding: [0.1, 0.2, 0.3],
      embeddingHash: 'parity-embedding-hash',
      embeddingSetId: embeddingSet.id,
      id: job.id,
      leaseToken: reclaimed.lease_token,
    },
  ]);
  expect(completed.map((completedJob) => completedJob.id)).toEqual([job.id]);
  expect(completed[0]?.state).toBe('succeeded');
  await expect(chunkRepository.findById('chunk-1')).resolves.toMatchObject({
    embedding: [0.1, 0.2, 0.3],
    embeddingHash: 'parity-embedding-hash',
    embeddingSetId: embeddingSet.id,
  });
  await expect(queue.getQueueStats('embeddings')).resolves.toEqual([
    expect.objectContaining({ queue: 'embeddings', queued: 0, running: 0, succeeded: 1 }),
  ]);

  // Stale lease tokens cannot complete a job (multi-writer CAS guard).
  const stale = await queue.enqueue({
    jobType: 'embed_chunk',
    payload: { chunkId: 'chunk-1', embeddingSetId: embeddingSet.id },
    queue: 'embeddings',
  });
  const [staleClaim] = await queue.claimMany({
    leaseMs: 60_000,
    limit: 1,
    queue: 'embeddings',
    workerId: 'worker-c',
  });
  expect(staleClaim?.id).toBe(stale.id);
  await client.exec('UPDATE job_queue SET lease_token = ? WHERE id = ?', ['stolen', stale.id]);
  const staleCompleted = await queue.completeEmbeddingChunkBatch([
    {
      chunkId: 'chunk-1',
      embedding: [0.9, 0.8, 0.7],
      embeddingHash: 'stale-embedding-hash',
      embeddingSetId: embeddingSet.id,
      id: stale.id,
      leaseToken: staleClaim?.lease_token ?? '',
    },
  ]);
  expect(staleCompleted).toEqual([]);
  await expect(chunkRepository.findById('chunk-1')).resolves.toMatchObject({
    embeddingHash: 'parity-embedding-hash',
  });
  // The rejected completion must leave the stale job untouched: still leased
  // out under the stolen token, never flipped to succeeded (raw read — the
  // queue API has no by-id getter).
  const staleJobRows = await client.query<{ state: string }>(
    'SELECT state FROM job_queue WHERE id = ?',
    [stale.id]
  );
  expect(staleJobRows.rows.map((row) => row.state)).toEqual(['running']);
}

export async function runManagedCacheApplyContract(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  const fileRecords = new TursoFileRecordRepository(client);
  const embeddingSets = new TursoEmbeddingSetsRepository(client);
  await seedParityRoot(client, 'root-1', 'Root 1');
  const embeddingSet = await embeddingSets.getOrCreateSet(
    'local::managed-cache-parity',
    'managed-cache-parity',
    384,
    'cosine'
  );

  // Import writes the record and refreshes collection stats.
  await applyTursoManagedCacheBatch(client, {
    changes: [
      {
        mode: 'import',
        record: {
          content: 'export const value = 1;',
          contentHash: 'hash-1',
          createdAt: '2026-06-23T12:00:00.000Z',
          id: 'file-1',
          mtimeMs: 1234.75,
          name: 'Alpha.ts',
          path: 'src/alpha.ts',
          processedAt: '2026-06-23T12:00:00.000Z',
          size: 24,
          tokenCount: 5,
          updatedAt: '2026-06-23T12:00:00.000Z',
        },
      },
    ],
    embeddingSetId: embeddingSet.id,
    rootId: 'root-1',
  });
  await expect(fileRecords.findById('file-1')).resolves.toMatchObject({
    content: 'export const value = 1;',
    embeddingSetId: embeddingSet.id,
    name: 'Alpha.ts',
    path: 'src/alpha.ts',
  });
  await expect(readCollectionStats(client, embeddingSet.id)).resolves.toMatchObject({
    chunk_count: 0,
    dirty: 0,
    file_count: 1,
    pending_chunk_count: 0,
  });
  await expect(fileRecords.findByNameSubstring('alpha', 50)).resolves.toEqual([
    expect.objectContaining({ id: 'file-1', name: 'Alpha.ts' }),
  ]);

  // Replace rewrites the record and keeps quick-open grams consistent.
  await applyTursoManagedCacheBatch(client, {
    changes: [
      {
        mode: 'replace',
        record: {
          content: 'export const value = 2;',
          contentHash: 'hash-2',
          id: 'file-1',
          mtimeMs: 1234.75,
          name: 'Beta.ts',
          path: 'src/beta.ts',
          processedAt: '2026-06-23T12:00:00.000Z',
          size: 24,
          tokenCount: 5,
          updatedAt: '2026-06-23T12:00:00.000Z',
        },
      },
    ],
    embeddingSetId: embeddingSet.id,
    rootId: 'root-1',
  });
  await expect(fileRecords.findByNameSubstring('alpha', 50)).resolves.toEqual([]);
  await expect(fileRecords.findByNameSubstring('beta', 50)).resolves.toEqual([
    expect.objectContaining({ id: 'file-1', name: 'Beta.ts' }),
  ]);

  // Identity-scoped invalidation removes the record and its grams.
  await invalidateTursoManagedCacheEntriesByIdentity(client, {
    embeddingSetId: embeddingSet.id,
    targets: [
      {
        expectedFileRecordId: 'file-1',
        mode: 'exact',
        relativePath: 'src/beta.ts',
        rootId: 'root-1',
      },
    ],
  });
  await expect(fileRecords.findByNameSubstring('beta', 50)).resolves.toEqual([]);
  await expect(fileRecords.findById('file-1')).resolves.toBeNull();
}

export async function runCollectionStatsRefreshContract(
  client: BrainstrikeDbExecutionClient
): Promise<void> {
  const embeddingSets = new TursoEmbeddingSetsRepository(client);
  const fileRecords = new TursoFileRecordRepository(client);
  const chunkRepository = new TursoFileChunkRepository(client);
  const embeddingSet = await embeddingSets.getOrCreateSet(
    'local::stats-parity',
    'stats-parity',
    3,
    'cosine'
  );
  const otherSet = await embeddingSets.getOrCreateSet(
    'local::stats-parity-other',
    'stats-parity-other',
    3,
    'cosine'
  );

  // markDirty flags exactly the requested unique rows.
  await markTursoCollectionIndexingStatsDirty(client, []);
  await markTursoCollectionIndexingStatsDirty(client, [
    embeddingSet.id,
    embeddingSet.id,
    otherSet.id,
  ]);
  await expect(readCollectionStats(client, embeddingSet.id)).resolves.toMatchObject({ dirty: 1 });
  await expect(readCollectionStats(client, otherSet.id)).resolves.toMatchObject({ dirty: 1 });

  // Refresh recomputes counts with inherited file-record chunk ownership and
  // recreates a deleted stats row.
  await fileRecords.createWithContent(
    createParityRecord({ embeddingSetId: embeddingSet.id, id: 'file-1' })
  );
  await chunkRepository.insert(
    createParityChunk({ content: 'export const pending = 1;', contentHash: 'chunk-hash-pending', id: 'chunk-pending' })
  );
  await chunkRepository.insert(
    createParityChunk({
      chunkIndex: 1,
      content: 'export const embedded = 1;',
      contentHash: 'chunk-hash-embedded',
      embedding: [0.1, 0.2, 0.3],
      embeddingSetId: embeddingSet.id,
      id: 'chunk-embedded',
    })
  );
  await client.exec('DELETE FROM collection_indexing_stats WHERE embedding_set_id = ?', [
    embeddingSet.id,
  ]);

  await refreshTursoCollectionIndexingStats(client, [embeddingSet.id, embeddingSet.id]);

  await expect(readCollectionStats(client, embeddingSet.id)).resolves.toMatchObject({
    chunk_count: 2,
    dirty: 0,
    embedded_chunk_count: 1,
    file_count: 1,
    pending_chunk_count: 1,
  });

  // The transaction-scoped variant produces the same values.
  await markTursoCollectionIndexingStatsDirty(client, [embeddingSet.id]);
  await client.transaction((tx) => refreshTursoCollectionIndexingStats(tx, [embeddingSet.id]));
  await expect(readCollectionStats(client, embeddingSet.id)).resolves.toMatchObject({
    chunk_count: 2,
    dirty: 0,
    embedded_chunk_count: 1,
    pending_chunk_count: 1,
  });
}

interface NormalizedCollectionStatsRow {
  readonly chunk_count: number;
  readonly dirty: number;
  readonly embedded_chunk_count: number;
  readonly file_count: number;
  readonly pending_chunk_count: number;
}

/**
 * Raw stats read normalized via Number(): integer typing at the raw-SQL driver
 * boundary is a documented runtime tolerance, the VALUES are contract.
 */
async function readCollectionStats(
  client: BrainstrikeDbExecutionClient,
  embeddingSetId: string
): Promise<NormalizedCollectionStatsRow | undefined> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT file_count, chunk_count, embedded_chunk_count, pending_chunk_count, dirty
       FROM collection_indexing_stats
      WHERE embedding_set_id = ?`,
    [embeddingSetId]
  );
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  return {
    chunk_count: Number(row['chunk_count']),
    dirty: Number(row['dirty']),
    embedded_chunk_count: Number(row['embedded_chunk_count']),
    file_count: Number(row['file_count']),
    pending_chunk_count: Number(row['pending_chunk_count']),
  };
}

async function seedParityRoot(
  client: BrainstrikeDbExecutionClient,
  id: string,
  displayName: string
): Promise<void> {
  await client.exec(
    `INSERT INTO roots (id, kind, display_name, path, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, 'path', displayName, `/workspace/${id}`, 'live', '2026-06-23T07:00:00.000Z']
  );
}

function createParityRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    content: 'const answer = 42;',
    contentHash: `hash-file-${overrides.id ?? 'file-1'}`,
    createdAt: '2026-06-23T08:00:00.000Z',
    id: 'file-1',
    name: 'index.ts',
    path: 'src/index.ts',
    size: 42,
    tokenCount: 8,
    updatedAt: '2026-06-23T08:00:00.000Z',
    ...overrides,
  };
}

function createParityChunk(overrides: Partial<FileChunkInsert> = {}): FileChunkInsert {
  return {
    chunkIndex: 0,
    chunkSize: 18,
    chunkType: 'code',
    content: 'const answer = 42;',
    contentHash: 'hash-chunk-1',
    createdAt: '2026-06-23T08:10:00.000Z',
    fileRecordId: 'file-1',
    id: 'chunk-1',
    tokenCount: 4,
    updatedAt: '2026-06-23T08:10:00.000Z',
    ...overrides,
  };
}
