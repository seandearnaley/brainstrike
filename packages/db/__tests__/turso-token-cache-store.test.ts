import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrainstrikeDbExecutionClient } from '../src/architecture/brainstrike-db-client-contract.js';
import type { TokenCacheEntry } from '../src/repositories/token-cache-store-types.js';
import { TursoTokenCacheStore } from '../src/repositories/turso-token-cache-store.js';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import { applyTursoSchemaBaseline } from '../src/turso/schema-baseline.js';

describe('TursoTokenCacheStore', () => {
  const folderId = 'test-folder-001';
  let client: TursoOwnerClient;
  let store: TursoTokenCacheStore;
  let tempDir: string;

  function createEntry(overrides: Partial<TokenCacheEntry> = {}): TokenCacheEntry {
    return {
      contentHash: 'abc123',
      countingMode: 'accurate',
      createdAt: new Date().toISOString(),
      filePath: 'src/test.ts',
      fileSize: 1024,
      folderId,
      modelEncoding: 'o200k_base',
      mtimeMs: Date.now(),
      tokenCount: 100,
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-token-cache-'));
    client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    await applyTursoSchemaBaseline(client);
    store = new TursoTokenCacheStore(client);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('upserts and reads token cache entries through the Turso owner client', async () => {
    await store.set(createEntry({ filePath: 'src/file.ts', tokenCount: 100 }));
    await store.set(createEntry({ filePath: 'src/file.ts', tokenCount: 200 }));

    await expect(store.get(folderId, 'src/file.ts')).resolves.toMatchObject({
      countingMode: 'accurate',
      filePath: 'src/file.ts',
      tokenCount: 200,
    });
  });

  it('supports batch lookup, totals, stats, and counting-mode queries', async () => {
    await store.setBatch([
      createEntry({ filePath: 'src/a.ts', tokenCount: 100 }),
      createEntry({ filePath: 'src/b.ts', tokenCount: 200, countingMode: 'heuristic' }),
      createEntry({ filePath: 'src/c.ts', tokenCount: 300, countingMode: 'heuristic' }),
    ]);

    const batch = await store.getBatch(folderId, ['src/a.ts', 'src/c.ts']);
    expect([...batch.keys()]).toEqual(['src/a.ts', 'src/c.ts']);
    await expect(store.getTotalTokens(folderId, ['src/a.ts', 'src/b.ts'])).resolves.toBe(300);
    await expect(store.getStats(folderId)).resolves.toMatchObject({
      accurateCount: 1,
      entryCount: 3,
      heuristicCount: 2,
      totalTokens: 600,
    });
    await expect(store.findByCountingMode(folderId, 'heuristic', 1)).resolves.toHaveLength(1);
  });

  it('chunks large path lookups below SQLite parameter limits', async () => {
    await store.setBatch([
      createEntry({ filePath: 'src/file-0001.ts', tokenCount: 10 }),
      createEntry({ filePath: 'src/file-1199.ts', tokenCount: 30 }),
    ]);

    const guardedClient: BrainstrikeDbExecutionClient = {
      exec: client.exec,
      query: async (sql, params, options) => {
        if (sql.includes('file_path IN') && (params?.length ?? 0) > 901) {
          throw new Error('large path lookups must be chunked below the SQLite parameter budget');
        }
        return client.query(sql, params, options);
      },
      transaction: client.transaction,
    };
    const guardedStore = new TursoTokenCacheStore(guardedClient);
    const filePaths = Array.from(
      { length: 1200 },
      (_, index) => `src/file-${String(index).padStart(4, '0')}.ts`
    );
    filePaths.push('src/file-0001.ts');

    const batch = await guardedStore.getBatch(folderId, filePaths);
    expect([...batch.keys()]).toEqual(['src/file-0001.ts', 'src/file-1199.ts']);
    await expect(guardedStore.getTotalTokens(folderId, filePaths)).resolves.toBe(40);
  });

  it('deletes folder-scoped entries without crossing folder boundaries', async () => {
    await store.set(createEntry({ filePath: 'src/a.ts' }));
    await store.set(createEntry({ filePath: 'src/b.ts' }));
    await store.set(createEntry({ folderId: 'other-folder', filePath: 'src/a.ts' }));

    await expect(store.delete(folderId, 'src/a.ts')).resolves.toBe(true);
    await expect(store.delete(folderId, 'src/missing.ts')).resolves.toBe(false);
    await expect(store.clearFolder(folderId)).resolves.toBe(1);
    await expect(store.getAllForFolder('other-folder')).resolves.toHaveLength(1);
    await expect(store.clearAll()).resolves.toBe(1);
  });

  it('reports clear counts from the same delete statement that removes rows', async () => {
    await store.set(createEntry({ filePath: 'src/a.ts' }));
    await store.set(createEntry({ filePath: 'src/b.ts' }));

    const noPreCountClient: BrainstrikeDbExecutionClient = {
      exec: client.exec,
      query: async (sql, params, options) => {
        if (/SELECT\s+COUNT\(\*\)\s+AS\s+row_count\s+FROM\s+file_token_cache/i.test(sql)) {
          throw new Error('clear counts must not use a pre-delete count query');
        }
        return client.query(sql, params, options);
      },
      transaction: client.transaction,
    };
    const guardedStore = new TursoTokenCacheStore(noPreCountClient);

    await expect(guardedStore.clearFolder(folderId)).resolves.toBe(2);
    await expect(store.getAllForFolder(folderId)).resolves.toHaveLength(0);
  });

  it('rejects unsafe relative paths before writing a batch', async () => {
    await expect(
      store.setBatch([
        createEntry({ filePath: 'src/valid.ts' }),
        createEntry({ filePath: '../escape.ts' }),
      ])
    ).rejects.toThrow('Token cache file path must not contain relative traversal segments');

    await expect(store.getAllForFolder(folderId)).resolves.toHaveLength(0);
  });

  it('rejects malformed stored text timestamps when reading rows', async () => {
    await store.set(createEntry({ filePath: 'src/file.ts' }));
    await client.exec('UPDATE file_token_cache SET created_at = ? WHERE folder_id = ?', [
      'CURRENT_TIMESTAMP',
      folderId,
    ]);

    await expect(store.get(folderId, 'src/file.ts')).rejects.toThrow(
      'Turso token cache timestamp has invalid stored value "CURRENT_TIMESTAMP".'
    );
  });
});
