import { serialize } from 'node:v8';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryHost } from '../host-core.js';
import type { QueryResponse, SqliteGrepRows } from '../protocol.js';
import { SqliteRuntimeRefusedError } from '../runtime-refusal.js';

const { grepMock } = vi.hoisted(() => ({ grepMock: vi.fn<() => SqliteGrepRows>() }));
vi.mock('../sandbox.js', () => ({
  SqliteSandbox: class {
    close(): void {}
    grep(): SqliteGrepRows {
      return grepMock();
    }
  },
}));

beforeEach(() => grepMock.mockReset());

const identity = { embedding: { indexMode: 'text-only' as const }, storeId: 'a'.repeat(64) };
const grep = (id: number) => ({
  caseSensitive: false,
  id,
  isRegex: false,
  kind: 'grep',
  maxRows: 1,
  pattern: 'needle',
  rootIds: ['root'],
});

describe('complete process response budget', () => {
  it('preserves a runtime refusal through the process response boundary', () => {
    const responses: QueryResponse[] = [];
    const receive = createQueryHost((response) => responses.push(response));
    receive({ databasePath: 'owned.sqlite', id: 1, kind: 'open' });
    const refusal = new SqliteRuntimeRefusedError('Engine memory accounting is unavailable.');
    grepMock.mockImplementationOnce(() => {
      throw refusal;
    });
    receive(grep(2));
    expect(responses.at(-1)).toEqual({
      id: 2,
      kind: 'error',
      message: refusal.message,
      name: refusal.name,
    });
    expect(refusal.code).toBe('sqlite_runtime_refused');
  });
  it('refuses native coverage in a grep owner', () => {
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
  it('refuses grep in a trusted coverage owner', () => {
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
    receive(grep(2));
    expect(responses.at(-1)).toMatchObject({
      kind: 'error',
      message: 'SQLite query process has not been initialized.',
    });
    expect(grepMock).not.toHaveBeenCalled();
  });
  it('refuses a response whose envelope exceeds the budget and retains grep admission', () => {
    const responses: QueryResponse[] = [];
    const receive = createQueryHost((response) => responses.push(response));
    receive({ databasePath: 'owned.sqlite', id: 1, kind: 'open' });
    const sized = (length: number) => ({
      columns: ['x'.repeat(length)],
      identity,
      matchedChunks: 0,
      rows: [],
      truncated: false,
    });
    // The result alone sits exactly at the budget; only the envelope crosses it.
    const result = sized(2 * 1024 * 1024 - serialize(sized(1024 * 1024)).byteLength);
    expect(serialize(result).byteLength).toBe(1024 * 1024);
    expect(serialize({ id: 2, kind: 'grepRows', result }).byteLength).toBeGreaterThan(1024 * 1024);
    grepMock.mockReturnValueOnce(result);
    receive(grep(2));
    expect(responses.at(-1)).toEqual({
      id: 2,
      kind: 'error',
      message: expect.stringContaining('process-message budget'),
      name: 'RangeError',
    });
    const small = {
      columns: ['id'],
      identity,
      matchedChunks: 1,
      rows: [[1n, new Uint8Array([2])]],
      truncated: false,
    };
    grepMock.mockReturnValueOnce(small);
    receive(grep(3));
    expect(responses.at(-1)).toEqual({ id: 3, kind: 'grepRows', result: small });
  });
});
