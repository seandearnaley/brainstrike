import { parseLensFile, ToolInputError } from '@brainstrike/assistant-contract';
import { SqliteQueryInputError } from '@brainstrike/sqlite-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDatabaseMock = vi.hoisted(() => vi.fn());
vi.mock('../../db-main', () => ({ getDatabase: getDatabaseMock }));
vi.mock('electron', () => ({ app: { isReady: () => true }, utilityProcess: { fork: vi.fn() } }));
const { runQuerySelf } = await import('../../assistant-server/query-self-tool');

function createClient() {
  return {
    close: vi.fn(async () => undefined),
    describeTable: vi.fn(async () => ({
      columns: ['name', 'type', 'notnull'],
      rows: [['id', 'TEXT', 1]],
      truncated: false,
    })),
    listTables: vi.fn(async () => ({
      columns: ['name', 'type'],
      rows: [['file_chunks', 'table']],
      truncated: false,
    })),
    query: vi.fn(async () => ({ columns: ['id', 'id'], rows: [[1, 2]], truncated: false })),
  };
}

beforeEach(() => {
  getDatabaseMock.mockReset();
  getDatabaseMock.mockRejectedValue(new Error('Index requests must not acquire the app database.'));
});

describe('explicit index query target', () => {
  it('closes an acquired reader when Stop wins before query admission', async () => {
    const client = createClient();
    const acquisition = Promise.withResolvers<typeof client>();
    const controller = new AbortController();
    const reason = new Error('Stop during acquisition');
    const outcome = runQuerySelf({ mode: 'query', sql: 'SELECT 1', target: 'index' }, undefined, {
      openIndexQuery: () => acquisition.promise,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    controller.abort(reason);
    acquisition.resolve(client);
    expect(await outcome).toBe(reason);
    expect(client.query).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('reports an unavailable index without acquiring the application database', async () => {
    await expect(runQuerySelf({ mode: 'listTables', target: 'index' }, undefined)).rejects.toThrow(
      'SQLite workspace index is unavailable'
    );
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });

  it('uses the index client, preserves positional columns and closes its owner', async () => {
    const client = createClient();
    const result = await runQuerySelf(
      { mode: 'query', sql: 'SELECT 1 AS id,2 AS id', target: 'index' },
      undefined,
      { openIndexQuery: async () => client }
    );
    expect(result).toEqual({
      columns: ['id', 'id'],
      kind: 'rows',
      rowCount: 1,
      rows: [{ cells: ['1', '2'] }],
      target: 'index',
      truncated: false,
    });
    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('reports schema without inventing PostgreSQL row estimates', async () => {
    const client = createClient();
    expect(
      await runQuerySelf({ mode: 'listTables', target: 'index' }, undefined, {
        openIndexQuery: async () => client,
      })
    ).toEqual({
      kind: 'tables',
      tables: [{ estimatedRows: null, name: 'file_chunks' }],
      target: 'index',
    });
    expect(
      await runQuerySelf(
        { mode: 'describeTable', table: 'file_chunks', target: 'index' },
        undefined,
        { openIndexQuery: async () => client }
      )
    ).toEqual({
      columns: [{ dataType: 'TEXT', name: 'id', nullable: false }],
      kind: 'columns',
      table: 'file_chunks',
      target: 'index',
    });
  });

  it('refuses analyze before acquiring a SQLite process', async () => {
    const openIndexQuery = vi.fn();
    await expect(
      runQuerySelf(
        { analyze: true, mode: 'explain', sql: 'SELECT 1', target: 'index' },
        undefined,
        { openIndexQuery }
      )
    ).rejects.toThrow(ToolInputError);
    expect(openIndexQuery).not.toHaveBeenCalled();
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });

  it('returns actionable SQLite input errors and still joins cleanup', async () => {
    const client = createClient();
    client.query.mockRejectedValue(new SqliteQueryInputError('no such table: unknown', 'Error'));
    await expect(
      runQuerySelf({ mode: 'query', sql: 'SELECT * FROM unknown', target: 'index' }, undefined, {
        openIndexQuery: async () => client,
      })
    ).rejects.toThrow('no such table: unknown');
    expect(client.close).toHaveBeenCalledOnce();
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });

  it('plans with SQLite EXPLAIN QUERY PLAN without executing analyze', async () => {
    const client = createClient();
    expect(
      await runQuerySelf({ mode: 'explain', sql: 'SELECT 1', target: 'index' }, undefined, {
        openIndexQuery: async () => client,
      })
    ).toEqual({ analyzed: false, kind: 'plan', plan: ['1\t2'], target: 'index' });
    expect(client.query).toHaveBeenCalledWith('EXPLAIN QUERY PLAN SELECT 1', { maxRows: 200 });
    expect(client.close).toHaveBeenCalledOnce();
  });
  it('routes an explicitly declared vector requirement by parameter name, independent of lens filename', async () => {
    const parsed = parseLensFile(
      'custom-seed-query.sql',
      [
        '-- description: Explicit vectors',
        '-- target: index',
        '-- requires: caller-vectors symbol',
        '-- param: terms text',
        '-- param: symbol text',
        'SELECT $1,$2 WHERE $brainstrike_collection IS NOT NULL AND $brainstrike_profile IS NOT NULL AND $brainstrike_files IS NOT NULL',
      ].join('\n')
    );
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const scan = {
      entries: [
        {
          absPath: '/root/.brainstrike/lenses/custom-seed-query.sql',
          fileName: 'custom-seed-query.sql',
          lens: parsed.lens,
          sourceRootId: 'root',
          status: 'ok' as const,
        },
      ],
      incompleteDirs: [],
      lenses: [parsed.lens],
    };
    const context = {
      collectionId: 'collection',
      fileIds: ['file'],
      profile: { modelId: 'selected' },
      storeId: 'a'.repeat(64),
    };
    const client = createClient();
    const hostile = "add'; DELETE FROM file_chunks; --";
    await runQuerySelf(
      { lens: 'custom-seed-query', mode: 'lens', target: 'index', values: ['disposer', hostile] },
      undefined,
      {
        openIndexQuery: async () => client,
        scanLenses: () => scan,
        withIndexCallerRead: (work) => work(context),
      }
    );
    expect(client.query).toHaveBeenCalledWith(
      'SELECT $1,$2 WHERE $brainstrike_collection IS NOT NULL AND $brainstrike_profile IS NOT NULL AND $brainstrike_files IS NOT NULL',
      {
        bindings: { ['$1']: 'disposer', ['$2']: hostile },
        maxRows: 50,
        requirement: { context, kind: 'caller-vectors', symbol: hostile },
      }
    );
    expect(client.close).toHaveBeenCalledOnce();
    expect(getDatabaseMock).not.toHaveBeenCalled();
    const listing = await runQuerySelf({ mode: 'listLenses', target: 'index' }, undefined, {
      scanLenses: () => scan,
    });
    expect(listing).toMatchObject({
      lenses: [{ requirement: { kind: 'caller-vectors', seedParam: 'symbol' } }],
    });
  });
});
