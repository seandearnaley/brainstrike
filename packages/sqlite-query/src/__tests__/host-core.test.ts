import { serialize } from 'node:v8';
import { describe, expect, it, vi } from 'vitest';
import { createQueryHost } from '../host-core.js';
import type { QueryResponse, SqliteRows } from '../protocol.js';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn<() => SqliteRows>() }));
vi.mock('../sandbox.js', () => ({
  SqliteSandbox: class {
    close(): void {}
    query(): SqliteRows {
      return queryMock();
    }
  },
}));

describe('complete process response budget', () => {
  it('refuses native coverage in a generic SQL owner', () => {
    const responses: QueryResponse[] = [];
    const receive = createQueryHost((response) => responses.push(response));
    receive({ databasePath: 'owned.sqlite', id: 1, kind: 'open' });
    receive({
      id: 2,
      kind: 'native-coverage',
      requests: [{ scope: { kind: 'workspace', rootId: 'root' } }],
    });
    expect(responses.at(-1)).toMatchObject({
      error: { message: expect.stringContaining('coverage-only owner') },
      kind: 'nativeCoverageError',
    });
  });
  it('refuses generic SQL in a trusted coverage owner', () => {
    const responses: QueryResponse[] = [];
    const receive = createQueryHost((response) => responses.push(response));
    receive({
      authority: {
        authorityEpoch: 'b'.repeat(64),
        authorityRevision: 7,
        dbPath: '/owned.sqlite',
        fileBindings: [],
        rootIds: [],
        scopes: [],
        storeId: 'a'.repeat(64),
      },
      id: 1,
      kind: 'open-native-coverage',
    });
    receive({ id: 2, kind: 'query', maxRows: 1, sql: 'SELECT 1', values: [] });
    expect(responses.at(-1)).toMatchObject({
      kind: 'error',
      message: 'SQLite query process has not been initialized.',
    });
    expect(queryMock).not.toHaveBeenCalled();
  });
  it('refuses a response whose envelope exceeds the budget and retains query admission', () => {
    const responses: QueryResponse[] = [];
    const receive = createQueryHost((response) => responses.push(response));
    receive({ databasePath: 'owned.sqlite', id: 1, kind: 'open' });
    const result = { columns: ['x'.repeat(1024 * 1024 - 64)], rows: [], truncated: false };
    expect(serialize(result).byteLength).toBeLessThan(1024 * 1024);
    expect(serialize({ id: 2, kind: 'rows', result }).byteLength).toBeGreaterThan(1024 * 1024);
    queryMock.mockReturnValueOnce(result);
    receive({ id: 2, kind: 'query', maxRows: 1, sql: 'SELECT 1', values: [] });
    expect(responses.at(-1)?.kind).toBe('error');
    expect(responses.at(-1)).toEqual({
      id: 2,
      kind: 'error',
      message: expect.stringContaining('process-message budget'),
      name: 'RangeError',
    });
    queryMock.mockReturnValueOnce({
      columns: ['value'],
      rows: [[1n, new Uint8Array([2])]],
      truncated: false,
    });
    receive({ id: 3, kind: 'query', maxRows: 1, sql: 'SELECT 1', values: [] });
    expect(responses.at(-1)).toEqual({
      id: 3,
      kind: 'rows',
      result: { columns: ['value'], rows: [[1n, new Uint8Array([2])]], truncated: false },
    });
  });
});
