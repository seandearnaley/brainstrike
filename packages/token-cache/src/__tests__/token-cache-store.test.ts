import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLoggerError, mockLoggerWarn, mockLoggerInfo } = vi.hoisted(() => ({
  mockLoggerError: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@brainstrike/logging', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/logging')>('@brainstrike/logging');
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      debug: vi.fn(),
      error: mockLoggerError,
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
    })),
  };
});

import { TokenCacheStore } from '../token-cache-store';
import type { TokenCacheEntry } from '../types';

// Mock PGlite database
function createMockDb() {
  const mockRows: Map<string, Record<string, unknown>> = new Map();

  return {
    _mockRows: mockRows,
    query: vi.fn(
      async <T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }> => {
        const sqlLower = sql.toLowerCase();

        // Handle INSERT/UPSERT
        if (sqlLower.includes('insert into')) {
          const folderId = params?.[0] as string;
          const filePath = params?.[1] as string;
          const key = `${folderId}::${filePath}`;

          mockRows.set(key, {
            content_hash: params?.[2],
            counting_mode: params?.[6],
            created_at: new Date().toISOString(),
            file_path: filePath,
            file_size: String(params?.[3]),
            folder_id: folderId,
            id: mockRows.size + 1,
            model_encoding: params?.[7],
            mtime_ms: params?.[4] ? String(params?.[4]) : null,
            token_count: params?.[5],
            updated_at: new Date().toISOString(),
          });

          return { affectedRows: 1, rows: [] as T[] };
        }

        // Handle SELECT batch with IN (check this first - most specific)
        if (sqlLower.includes('select * from') && sqlLower.includes(' in (')) {
          const folderId = params?.[0] as string;
          const filePaths = params?.slice(1) as string[];
          const rows: T[] = [];
          for (const filePath of filePaths) {
            const key = `${folderId}::${filePath}`;
            const row = mockRows.get(key);
            if (row) {
              rows.push(row as T);
            }
          }
          return { rows };
        }

        // Handle SELECT single (has file_path = $2)
        if (sqlLower.includes('select * from') && sqlLower.includes('file_path = $2')) {
          const folderId = params?.[0] as string;
          const filePath = params?.[1] as string;
          const key = `${folderId}::${filePath}`;
          const row = mockRows.get(key);
          return { rows: row ? [row as T] : [] };
        }

        // Handle SELECT all for folder (only folder_id, no file_path)
        if (
          sqlLower.includes('select * from') &&
          sqlLower.includes('folder_id = $1') &&
          !sqlLower.includes('file_path')
        ) {
          const folderId = params?.[0] as string;
          const rows: T[] = [];
          for (const [key, row] of mockRows) {
            if (key.startsWith(`${folderId}::`)) {
              rows.push(row as T);
            }
          }
          return { rows };
        }

        // Handle findByCountingMode SELECT
        if (sqlLower.includes('select * from') && sqlLower.includes('counting_mode = $2')) {
          const folderId = params?.[0] as string;
          const mode = params?.[1] as string;
          const limit = (params?.[2] as number) || 100;
          const rows: T[] = [];
          let count = 0;
          for (const [key, row] of mockRows) {
            if (count >= limit) {
              break;
            }
            if (key.startsWith(`${folderId}::`) && row['counting_mode'] === mode) {
              rows.push(row as T);
              count++;
            }
          }
          return { rows };
        }

        // Handle COUNT/stats query (check this before SUM since getStats has both)
        if (sqlLower.includes('count(*)') && sqlLower.includes('as entry_count')) {
          let entryCount = 0;
          let totalTokens = 0;
          let accurateCount = 0;
          let heuristicCount = 0;

          const folderId = params?.[0] as string | undefined;

          for (const [key, row] of mockRows) {
            if (folderId && !key.startsWith(`${folderId}::`)) {
              continue;
            }
            entryCount++;
            totalTokens += row['token_count'] as number;
            if (row['counting_mode'] === 'accurate') {
              accurateCount++;
            } else {
              heuristicCount++;
            }
          }

          return {
            rows: [
              {
                accurate_count: String(accurateCount),
                entry_count: String(entryCount),
                heuristic_count: String(heuristicCount),
                total_tokens: String(totalTokens),
              },
            ] as T[],
          };
        }

        // Handle SUM query (getTotalTokens - has IN clause)
        if (sqlLower.includes('sum(token_count)') && sqlLower.includes(' in (')) {
          const folderId = params?.[0] as string;
          const filePaths = params?.slice(1) as string[];
          let total = 0;
          for (const filePath of filePaths) {
            const key = `${folderId}::${filePath}`;
            const row = mockRows.get(key);
            if (row) {
              total += row['token_count'] as number;
            }
          }
          return { rows: [{ total: String(total) }] as T[] };
        }

        // Handle DELETE single
        if (sqlLower.includes('delete from') && sqlLower.includes('file_path = $2')) {
          const folderId = params?.[0] as string;
          const filePath = params?.[1] as string;
          const key = `${folderId}::${filePath}`;
          const existed = mockRows.has(key);
          mockRows.delete(key);
          return { affectedRows: existed ? 1 : 0, rows: [] as T[] };
        }

        // Handle DELETE folder
        if (
          sqlLower.includes('delete from') &&
          sqlLower.includes('folder_id = $1') &&
          !params?.[1]
        ) {
          const folderId = params?.[0] as string;
          let deleted = 0;
          for (const key of mockRows.keys()) {
            if (key.startsWith(`${folderId}::`)) {
              mockRows.delete(key);
              deleted++;
            }
          }
          return { affectedRows: deleted, rows: [] as T[] };
        }

        // Handle DELETE all
        if (sqlLower.includes('delete from file_token_cache') && !params?.length) {
          const count = mockRows.size;
          mockRows.clear();
          return { affectedRows: count, rows: [] as T[] };
        }

        // Handle BEGIN/COMMIT/ROLLBACK
        if (
          sqlLower.includes('begin') ||
          sqlLower.includes('commit') ||
          sqlLower.includes('rollback')
        ) {
          return { rows: [] as T[] };
        }

        // Handle ANALYZE
        if (sqlLower.includes('analyze')) {
          return { rows: [] as T[] };
        }

        return { rows: [] as T[] };
      }
    ),
  };
}

const asStoreDatabase = (
  db: ReturnType<typeof createMockDb>
): ConstructorParameters<typeof TokenCacheStore>[0] =>
  db as unknown as ConstructorParameters<typeof TokenCacheStore>[0];

describe('TokenCacheStore', () => {
  let store: TokenCacheStore;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockLoggerError.mockClear();
    mockLoggerWarn.mockClear();
    mockLoggerInfo.mockClear();
    mockDb = createMockDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store = new TokenCacheStore(mockDb as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const createEntry = (overrides: Partial<TokenCacheEntry> = {}): TokenCacheEntry => ({
    contentHash: 'abc123def456',
    countingMode: 'accurate',
    filePath: 'src/index.ts',
    fileSize: 1000,
    folderId: 'folder-1',
    modelEncoding: 'o200k_base',
    mtimeMs: 1_700_000_000_000,
    tokenCount: 250,
    ...overrides,
  });

  describe('set and get', () => {
    it('reports lookup counts, hits, and duration for production get paths', async () => {
      const recordLookup = vi.fn();
      const instrumentedStore = new TokenCacheStore(mockDb as any, {
        telemetry: { recordLookup },
      });
      await instrumentedStore.set(createEntry());

      await instrumentedStore.get('folder-1', 'src/index.ts');
      await instrumentedStore.getBatch('folder-1', ['src/index.ts', 'src/missing.ts']);

      expect(recordLookup).toHaveBeenNthCalledWith(1, {
        durationMs: expect.any(Number),
        hitCount: 1,
        lookupCount: 1,
      });
      expect(recordLookup).toHaveBeenNthCalledWith(2, {
        durationMs: expect.any(Number),
        hitCount: 1,
        lookupCount: 2,
      });
    });

    it('surfaces telemetry sink failures without changing successful lookups', async () => {
      const instrumentedStore = new TokenCacheStore(mockDb as any, {
        telemetry: {
          recordLookup: () => {
            throw new Error('telemetry sink unavailable');
          },
        },
      });
      await instrumentedStore.set(createEntry());

      await expect(instrumentedStore.get('folder-1', 'src/index.ts')).resolves.toMatchObject({
        filePath: 'src/index.ts',
      });
      expect(mockLoggerError).toHaveBeenCalledWith(
        'Token cache lookup telemetry recording failed',
        { error: 'telemetry sink unavailable' }
      );
    });

    it('keeps lookup operations working when the telemetry clock is unavailable', async () => {
      const recordLookup = vi.fn();
      const instrumentedStore = new TokenCacheStore(mockDb as any, {
        telemetry: { recordLookup },
      });
      await instrumentedStore.set(createEntry());
      vi.stubGlobal('performance', undefined);

      await expect(instrumentedStore.get('folder-1', 'src/index.ts')).resolves.toMatchObject({
        filePath: 'src/index.ts',
      });
      await expect(instrumentedStore.getBatch('folder-1', ['src/index.ts'])).resolves.toEqual(
        new Map([
          [
            'src/index.ts',
            expect.objectContaining({ filePath: 'src/index.ts' }) as TokenCacheEntry,
          ],
        ])
      );
      await expect(instrumentedStore.getTotalTokens('folder-1', ['src/index.ts'])).resolves.toBe(
        250
      );

      expect(recordLookup).not.toHaveBeenCalled();
      expect(mockLoggerError).toHaveBeenCalledTimes(1);
    });

    it('stores and retrieves a single entry', async () => {
      const entry = createEntry();
      await store.set(entry);

      const result = await store.get('folder-1', 'src/index.ts');
      expect(result).toMatchObject({
        contentHash: 'abc123def456',
        countingMode: 'accurate',
        filePath: 'src/index.ts',
        fileSize: 1000,
        folderId: 'folder-1',
        modelEncoding: 'o200k_base',
        tokenCount: 250,
      });
    });

    it('returns null for non-existent entry', async () => {
      const result = await store.get('folder-1', 'non-existent.ts');
      expect(result).toBeNull();
    });

    it('upserts on conflict', async () => {
      const entry1 = createEntry({ tokenCount: 100 });
      await store.set(entry1);

      const entry2 = createEntry({ tokenCount: 200 });
      await store.set(entry2);

      const result = await store.get('folder-1', 'src/index.ts');
      expect(result?.tokenCount).toBe(200);
    });

    it('accepts safe relative paths with special characters', async () => {
      const specialPath = 'src/components/[id] (draft)#1.ts';
      await store.set(createEntry({ filePath: specialPath }));

      const result = await store.get('folder-1', specialPath);
      expect(result?.filePath).toBe(specialPath);
    });

    it('preserves significant leading and trailing whitespace in file paths', async () => {
      const spacedPath = ' src/index.ts ';
      await store.set(createEntry({ filePath: spacedPath }));

      const spacedResult = await store.get('folder-1', spacedPath);
      expect(spacedResult?.filePath).toBe(spacedPath);

      const trimmedResult = await store.get('folder-1', 'src/index.ts');
      expect(trimmedResult).toBeNull();
    });

    it('logs info when leading or trailing whitespace is preserved in cache keys', async () => {
      const spacedPath = ' src/index.ts ';
      await store.set(createEntry({ filePath: spacedPath }));

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        'Token cache file path has leading or trailing whitespace; preserving exact key',
        { filePath: spacedPath }
      );
    });
  });

  describe('file path validation', () => {
    it('rejects unsafe paths before writes reach the database', async () => {
      const invalidPaths = [
        '',
        '   ',
        '/absolute/path.ts',
        '../escape.ts',
        'src/../escape.ts',
        'src//double-slash.ts',
        'src/folder/',
        './relative-dot.ts',
        'C:\\secret.ts',
        '\\\\server\\share\\payload.ts',
        'src/\0null-byte.ts',
        'src/foo\tbar.ts',
      ];

      for (const invalidPath of invalidPaths) {
        await expect(store.set(createEntry({ filePath: invalidPath }))).rejects.toThrow();
      }

      // Each write validates before query execution, so every invalid path short-circuits DB access.
      expect(mockDb.query).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledTimes(invalidPaths.length);
    });

    it('rejects unsafe paths before read/delete queries execute', async () => {
      const guardedOperations = [
        {
          message: 'Token cache file path must not be empty',
          run: () => store.get('folder-1', ''),
        },
        {
          message: 'Token cache file path must not be empty',
          run: () => store.get('folder-1', '   '),
        },
        {
          message: 'Token cache file path must not contain control characters',
          run: () => store.get('folder-1', 'src/foo\tbar.ts'),
        },
        {
          message: 'Token cache file path must not contain relative traversal segments',
          run: () => store.get('folder-1', '../escape.ts'),
        },
        {
          message: 'Token cache file path must not contain empty segments',
          run: () => store.get('folder-1', 'src//double.ts'),
        },
        {
          message: 'Token cache file path must not contain empty segments',
          run: () => store.get('folder-1', 'src/folder/'),
        },
        {
          message: 'Token cache file path must be relative',
          run: () => store.getBatch('folder-1', ['safe.ts', '/absolute.ts']),
        },
        {
          message: 'Token cache file path must not contain relative traversal segments',
          run: () => store.getTotalTokens('folder-1', ['safe.ts', './dot.ts']),
        },
        {
          message: 'Token cache file path must be relative',
          run: () => store.delete('folder-1', 'C:\\windows\\abs.ts'),
        },
      ];

      for (const { run, message } of guardedOperations) {
        await expect(run()).rejects.toThrow(message);
      }

      expect(mockDb.query).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledTimes(guardedOperations.length);
    });
  });

  describe('getBatch', () => {
    it('retrieves multiple entries', async () => {
      await store.set(createEntry({ filePath: 'file1.ts', tokenCount: 100 }));
      await store.set(createEntry({ filePath: 'file2.ts', tokenCount: 200 }));
      await store.set(createEntry({ filePath: 'file3.ts', tokenCount: 300 }));

      const result = await store.getBatch('folder-1', ['file1.ts', 'file2.ts', 'file3.ts']);
      expect(result.size).toBe(3);
      expect(result.get('file1.ts')?.tokenCount).toBe(100);
      expect(result.get('file2.ts')?.tokenCount).toBe(200);
      expect(result.get('file3.ts')?.tokenCount).toBe(300);
    });

    it('returns empty map for empty input', async () => {
      const result = await store.getBatch('folder-1', []);
      expect(result.size).toBe(0);
    });

    it('returns only found entries', async () => {
      await store.set(createEntry({ filePath: 'file1.ts' }));

      const result = await store.getBatch('folder-1', ['file1.ts', 'non-existent.ts']);
      expect(result.size).toBe(1);
      expect(result.has('file1.ts')).toBe(true);
      expect(result.has('non-existent.ts')).toBe(false);
    });
  });

  describe('getAllForFolder', () => {
    it('reports folder preload duration without changing lookup totals', async () => {
      const recordLookup = vi.fn();
      const instrumentedStore = new TokenCacheStore(mockDb as any, {
        telemetry: { recordLookup },
      });
      await instrumentedStore.set(createEntry());

      await instrumentedStore.getAllForFolder('folder-1');

      expect(recordLookup).toHaveBeenCalledWith({
        durationMs: expect.any(Number),
        hitCount: 0,
        lookupCount: 0,
      });
    });

    it('retrieves all entries for a folder', async () => {
      await store.set(createEntry({ filePath: 'file1.ts', folderId: 'folder-1' }));
      await store.set(createEntry({ filePath: 'file2.ts', folderId: 'folder-1' }));
      await store.set(createEntry({ filePath: 'file3.ts', folderId: 'folder-2' }));

      const result = await store.getAllForFolder('folder-1');
      expect(result.length).toBe(2);
      expect(result.map((e) => e.filePath).sort()).toEqual(['file1.ts', 'file2.ts']);
    });
  });

  describe('setBatch', () => {
    it('stores multiple entries', async () => {
      const entries = [
        createEntry({ filePath: 'file1.ts', tokenCount: 100 }),
        createEntry({ filePath: 'file2.ts', tokenCount: 200 }),
      ];

      await store.setBatch(entries);

      const result1 = await store.get('folder-1', 'file1.ts');
      const result2 = await store.get('folder-1', 'file2.ts');
      expect(result1?.tokenCount).toBe(100);
      expect(result2?.tokenCount).toBe(200);
    });

    it('handles empty batch', async () => {
      await store.setBatch([]);
      expect(mockDb.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT'));
    });

    it('does not persist entries when a batch includes an invalid path', async () => {
      const entries = [
        createEntry({ filePath: 'valid.ts', tokenCount: 100 }),
        createEntry({ filePath: '../escape.ts', tokenCount: 200 }),
      ];

      await expect(store.setBatch(entries)).rejects.toThrow(
        'Token cache file path must not contain relative traversal segments'
      );

      const persisted = await store.get('folder-1', 'valid.ts');
      expect(persisted).toBeNull();
      expect(mockLoggerWarn).toHaveBeenCalledWith('Rejected unsafe token cache file path', {
        filePath: '../escape.ts',
        reason: 'Token cache file path must not contain relative traversal segments',
      });
    });

    it('retries the transaction when a transient commit failure occurs', async () => {
      const transientError = Object.assign(new Error('could not serialize access'), {
        code: '40001',
      });
      const defaultQuery = mockDb.query.getMockImplementation();
      let failedCommits = 0;
      mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.toLowerCase().includes('commit') && failedCommits === 0) {
          failedCommits += 1;
          throw transientError;
        }
        if (!defaultQuery) {
          throw new Error('Expected default token cache mock query implementation');
        }
        return defaultQuery(sql, params);
      });

      await store.setBatch([
        createEntry({ filePath: 'file1.ts', tokenCount: 100 }),
        createEntry({ filePath: 'file2.ts', tokenCount: 200 }),
      ]);

      const transactionStatements = mockDb.query.mock.calls
        .map(([sql]) => sql.trim().toUpperCase())
        .filter((sql) => sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK');
      expect(transactionStatements).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK', 'BEGIN', 'COMMIT']);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Retrying token cache batch transaction after transient failure',
        expect.objectContaining({
          attempt: 1,
          maxAttempts: 3,
          reason: 'could not serialize access',
        })
      );
    });

    it('retries using the original transaction error when rollback also fails', async () => {
      const transientError = Object.assign(new Error('could not serialize access'), {
        code: '40001',
      });
      const rollbackError = new Error('rollback connection lost');
      const defaultQuery = mockDb.query.getMockImplementation();
      let failedCommits = 0;
      let failedRollbacks = 0;
      mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const normalizedSql = sql.trim().toUpperCase();
        if (normalizedSql === 'COMMIT' && failedCommits === 0) {
          failedCommits += 1;
          throw transientError;
        }
        if (normalizedSql === 'ROLLBACK' && failedRollbacks === 0) {
          failedRollbacks += 1;
          throw rollbackError;
        }
        if (!defaultQuery) {
          throw new Error('Expected default token cache mock query implementation');
        }
        return defaultQuery(sql, params);
      });

      await store.setBatch([createEntry({ filePath: 'file1.ts', tokenCount: 100 })]);

      const transactionStatements = mockDb.query.mock.calls
        .map(([sql]) => sql.trim().toUpperCase())
        .filter((sql) => sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK');
      expect(transactionStatements).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK', 'BEGIN', 'COMMIT']);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Retrying token cache batch transaction after transient failure',
        expect.objectContaining({
          attempt: 1,
          reason: 'could not serialize access',
        })
      );
    });

    it('fails after exhausting transient transaction retries', async () => {
      const transientError = Object.assign(new Error('database is locked'), {
        code: 'SQLITE_BUSY',
      });
      const defaultQuery = mockDb.query.getMockImplementation();
      mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.toLowerCase().includes('commit')) {
          throw transientError;
        }
        if (!defaultQuery) {
          throw new Error('Expected default token cache mock query implementation');
        }
        return defaultQuery(sql, params);
      });

      await expect(
        store.setBatch([createEntry({ filePath: 'file1.ts', tokenCount: 100 })])
      ).rejects.toThrow('database is locked');

      const transactionStatements = mockDb.query.mock.calls
        .map(([sql]) => sql.trim().toUpperCase())
        .filter((sql) => sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK');
      expect(transactionStatements).toEqual([
        'BEGIN',
        'COMMIT',
        'ROLLBACK',
        'BEGIN',
        'COMMIT',
        'ROLLBACK',
        'BEGIN',
        'COMMIT',
        'ROLLBACK',
      ]);
      expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
    });

    it('keeps the configured attempt budget, uncapped backoff, and final error identity', async () => {
      const transientError = Object.assign(new Error('database is locked'), {
        code: 'SQLITE_BUSY',
      });
      const defaultQuery = mockDb.query.getMockImplementation();
      mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.trim().toUpperCase() === 'COMMIT') {
          throw transientError;
        }
        if (!defaultQuery) {
          throw new Error('Expected default token cache mock query implementation');
        }
        return defaultQuery(sql, params);
      });
      const configuredStore = new TokenCacheStore(asStoreDatabase(mockDb), {
        transactionRetryBaseDelayMs: 1,
        transactionRetryMaxAttempts: 4,
      });

      await expect(configuredStore.setBatch([createEntry()])).rejects.toBe(transientError);

      const transactionStatements = mockDb.query.mock.calls
        .map(([sql]) => sql.trim().toUpperCase())
        .filter((sql) => sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK');
      expect(transactionStatements).toEqual([
        'BEGIN',
        'COMMIT',
        'ROLLBACK',
        'BEGIN',
        'COMMIT',
        'ROLLBACK',
        'BEGIN',
        'COMMIT',
        'ROLLBACK',
        'BEGIN',
        'COMMIT',
        'ROLLBACK',
      ]);
      expect(mockLoggerWarn.mock.calls.map(([, details]) => details)).toEqual([
        {
          attempt: 1,
          code: 'SQLITE_BUSY',
          delayMs: 1,
          maxAttempts: 4,
          reason: 'database is locked',
        },
        {
          attempt: 2,
          code: 'SQLITE_BUSY',
          delayMs: 2,
          maxAttempts: 4,
          reason: 'database is locked',
        },
        {
          attempt: 3,
          code: 'SQLITE_BUSY',
          delayMs: 4,
          maxAttempts: 4,
          reason: 'database is locked',
        },
      ]);
    });

    it('does not retry a non-transient commit failure', async () => {
      const permanentError = new Error('constraint failed');
      const defaultQuery = mockDb.query.getMockImplementation();
      mockDb.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.trim().toUpperCase() === 'COMMIT') {
          throw permanentError;
        }
        if (!defaultQuery) {
          throw new Error('Expected default token cache mock query implementation');
        }
        return defaultQuery(sql, params);
      });

      await expect(store.setBatch([createEntry()])).rejects.toBe(permanentError);
      expect(
        mockDb.query.mock.calls
          .map(([sql]) => sql.trim().toUpperCase())
          .filter((sql) => sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
      ).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it('rejects retry delays too large for a native timer instead of waiting forever', () => {
      expect(
        () =>
          new TokenCacheStore(asStoreDatabase(mockDb), {
            transactionRetryBaseDelayMs: Number.MAX_VALUE,
            transactionRetryMaxAttempts: 2,
          })
      ).toThrow(RangeError);
    });

    it('allows a single attempt without scheduling a delay', async () => {
      const transientError = new Error('database is locked');
      mockDb.query.mockImplementation(async (sql: string) => {
        if (sql.trim().toUpperCase() === 'COMMIT') {
          throw transientError;
        }
        return { rows: [] };
      });
      const configuredStore = new TokenCacheStore(asStoreDatabase(mockDb), {
        transactionRetryBaseDelayMs: Number.MAX_VALUE,
        transactionRetryMaxAttempts: 1,
      });

      await expect(configuredStore.setBatch([createEntry()])).rejects.toBe(transientError);
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it('preserves a non-Error transient rejection value after retry exhaustion', async () => {
      const transientFailure = { code: '40001' };
      mockDb.query.mockImplementation(async (sql: string) => {
        if (sql.trim().toUpperCase() === 'COMMIT') {
          throw transientFailure;
        }
        return { rows: [] };
      });
      const configuredStore = new TokenCacheStore(asStoreDatabase(mockDb), {
        transactionRetryBaseDelayMs: 1,
        transactionRetryMaxAttempts: 2,
      });

      await expect(configuredStore.setBatch([createEntry()])).rejects.toBe(transientFailure);
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    });
  });

  describe('delete', () => {
    it('deletes a single entry', async () => {
      await store.set(createEntry({ filePath: 'file1.ts' }));

      const deleted = await store.delete('folder-1', 'file1.ts');
      expect(deleted).toBe(true);

      const result = await store.get('folder-1', 'file1.ts');
      expect(result).toBeNull();
    });

    it('returns false for non-existent entry', async () => {
      const deleted = await store.delete('folder-1', 'non-existent.ts');
      expect(deleted).toBe(false);
    });
  });

  describe('clearFolder', () => {
    it('clears all entries for a folder', async () => {
      await store.set(createEntry({ filePath: 'file1.ts', folderId: 'folder-1' }));
      await store.set(createEntry({ filePath: 'file2.ts', folderId: 'folder-1' }));
      await store.set(createEntry({ filePath: 'file3.ts', folderId: 'folder-2' }));

      const cleared = await store.clearFolder('folder-1');
      expect(cleared).toBe(2);

      const folder1Entries = await store.getAllForFolder('folder-1');
      expect(folder1Entries.length).toBe(0);

      const folder2Entries = await store.getAllForFolder('folder-2');
      expect(folder2Entries.length).toBe(1);
    });
  });

  describe('clearAll', () => {
    it('clears all entries', async () => {
      await store.set(createEntry({ filePath: 'file1.ts', folderId: 'folder-1' }));
      await store.set(createEntry({ filePath: 'file2.ts', folderId: 'folder-2' }));

      const cleared = await store.clearAll();
      expect(cleared).toBe(2);

      const stats = await store.getStats();
      expect(stats.entryCount).toBe(0);
    });
  });

  describe('getTotalTokens', () => {
    it('returns sum of token counts', async () => {
      await store.set(createEntry({ filePath: 'file1.ts', tokenCount: 100 }));
      await store.set(createEntry({ filePath: 'file2.ts', tokenCount: 200 }));
      await store.set(createEntry({ filePath: 'file3.ts', tokenCount: 300 }));

      const total = await store.getTotalTokens('folder-1', ['file1.ts', 'file2.ts', 'file3.ts']);
      expect(total).toBe(600);
    });

    it('returns 0 for empty input', async () => {
      const total = await store.getTotalTokens('folder-1', []);
      expect(total).toBe(0);
    });

    it('returns partial sum for mixed existing/non-existing', async () => {
      await store.set(createEntry({ filePath: 'file1.ts', tokenCount: 100 }));

      const total = await store.getTotalTokens('folder-1', ['file1.ts', 'non-existent.ts']);
      expect(total).toBe(100);
    });

    it('reports aggregate query duration without changing lookup or hit counts', async () => {
      const recordLookup = vi.fn();
      const instrumentedStore = new TokenCacheStore(mockDb as any, {
        telemetry: { recordLookup },
      });

      await instrumentedStore.getTotalTokens('folder-1', ['file1.ts']);

      expect(recordLookup).toHaveBeenCalledWith({
        durationMs: expect.any(Number),
        hitCount: 0,
        lookupCount: 0,
      });
    });

    it('reports aggregate query failures without changing the rejection', async () => {
      const recordLookup = vi.fn();
      const instrumentedStore = new TokenCacheStore(mockDb as any, {
        telemetry: { recordLookup },
      });
      mockDb.query.mockRejectedValueOnce(new Error('sum failed'));

      await expect(instrumentedStore.getTotalTokens('folder-1', ['file1.ts'])).rejects.toThrow(
        'sum failed'
      );
      expect(recordLookup).toHaveBeenCalledWith({
        durationMs: expect.any(Number),
        failed: true,
        hitCount: 0,
        lookupCount: 0,
      });
    });
  });

  describe('getStats', () => {
    it('returns overall stats', async () => {
      await store.set(
        createEntry({ countingMode: 'accurate', filePath: 'file1.ts', tokenCount: 100 })
      );
      await store.set(
        createEntry({ countingMode: 'heuristic', filePath: 'file2.ts', tokenCount: 200 })
      );

      const stats = await store.getStats();
      expect(stats.entryCount).toBe(2);
      expect(stats.totalTokens).toBe(300);
      expect(stats.accurateCount).toBe(1);
      expect(stats.heuristicCount).toBe(1);
    });

    it('returns folder-specific stats', async () => {
      await store.set(createEntry({ filePath: 'file1.ts', folderId: 'folder-1', tokenCount: 100 }));
      await store.set(createEntry({ filePath: 'file2.ts', folderId: 'folder-2', tokenCount: 200 }));

      const stats = await store.getStats('folder-1');
      expect(stats.entryCount).toBe(1);
      expect(stats.totalTokens).toBe(100);
    });
  });

  describe('vacuum', () => {
    it('runs ANALYZE without error', async () => {
      await store.vacuum();
      expect(mockDb.query).toHaveBeenCalledWith('ANALYZE file_token_cache');
    });
  });
});
