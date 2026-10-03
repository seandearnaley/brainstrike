import { ToolInputError } from '@brainstrike/assistant-contract';
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
});
