import {
  type BrowserPGliteStorageBenchmarkClient,
  runBrowserPGliteStorageBenchmark,
} from '../src/browser-pglite-storage-benchmark.js';

describe('browser PGlite storage benchmark harness', () => {
  it('runs the Brainstrike storage workloads against each selected backend', async () => {
    const createdBackends: string[] = [];
    const statements: string[] = [];
    const closed: string[] = [];

    await runBrowserPGliteStorageBenchmark({
      clock: (() => {
        let now = 0;
        return () => {
          now += 10;
          return now;
        };
      })(),
      createClient: async (selection): Promise<BrowserPGliteStorageBenchmarkClient> => {
        createdBackends.push(selection.storage);
        return {
          close: async () => {
            closed.push(selection.storage);
          },
          exec: async (sql) => {
            statements.push(sql);
          },
          query: async (sql) => {
            statements.push(sql);
            return { rows: [] };
          },
        };
      },
      rows: 2,
      selections: [
        { dataDir: 'idb://bench', reason: 'requested-indexeddb', storage: 'idb' },
        {
          dataDir: 'opfs-ahp://bench',
          reason: 'requested-opfs-ahp-supported',
          storage: 'opfs-ahp',
        },
      ],
    });

    expect(createdBackends).toEqual(['idb', 'opfs-ahp']);
    expect(closed).toEqual(['idb', 'opfs-ahp']);
    expect(statements.join('\n')).toContain(
      'CREATE TABLE IF NOT EXISTS bst_storage_benchmark_files'
    );
    expect(statements.join('\n')).toContain(
      'CREATE TABLE IF NOT EXISTS bst_storage_benchmark_chunks'
    );
    expect(statements.join('\n')).toContain(
      'CREATE INDEX IF NOT EXISTS bst_storage_benchmark_chunks_embedding_hnsw'
    );
    expect(statements.join('\n')).toContain('ORDER BY embedding <->');
  });

  it('fails fast for invalid benchmark row counts', async () => {
    await expect(
      runBrowserPGliteStorageBenchmark({
        createClient: async (): Promise<BrowserPGliteStorageBenchmarkClient> => ({
          exec: async () => undefined,
          query: async () => ({ rows: [] }),
        }),
        rows: 0,
        selections: [{ dataDir: 'idb://bench', reason: 'requested-indexeddb', storage: 'idb' }],
      })
    ).rejects.toThrow('Expected a positive integer row count, got 0');
  });
});
