import { describe, expect, it } from 'vitest';
import { SqliteQueryClient } from '../client.js';
import { decodeRequest, decodeResponse } from '../protocol.js';

const grep = {
  caseSensitive: true,
  id: 1,
  isRegex: false,
  kind: 'grep',
  maxRows: 50,
  pattern: 'needle',
  rootIds: ['root'],
};
const identity = { embedding: { indexMode: 'text-only' }, storeId: 'a'.repeat(64) };

describe('SQLite query process boundary', () => {
  it('rejects unknown command fields, invalid row limits and malformed scopes', () => {
    for (const message of [
      { databasePath: '/index.sqlite', disableAuthorizer: true, id: 1, kind: 'open' },
      { ...grep, maxRows: 201 },
      { ...grep, rootIds: [42] },
      { ...grep, sql: 'SELECT 1' },
    ]) {
      expect(() => decodeRequest(message)).toThrow(TypeError);
    }
    expect(decodeRequest(grep)).toEqual(grep);
  });

  it('refuses a caller-vector requirement, which no request carries any more', () => {
    expect(() =>
      decodeRequest({ ...grep, requirement: { kind: 'caller-vectors', symbol: 'add' } })
    ).toThrow(TypeError);
  });

  it('refuses the removed generic SQL kinds and their rows reply', () => {
    for (const message of [
      { id: 1, kind: 'query', maxRows: 50, sql: 'SELECT 1', values: [] },
      { id: 1, kind: 'listTables' },
      { id: 1, kind: 'describeTable', table: 'file_records' },
    ]) {
      expect(() => decodeRequest(message)).toThrow(TypeError);
    }
    expect(() =>
      decodeResponse({
        id: 1,
        kind: 'rows',
        result: { columns: ['id'], rows: [[1]], truncated: false },
      })
    ).toThrow(TypeError);
  });

  it('rejects malformed and unrecognized child replies', () => {
    const result = {
      columns: ['id'],
      identity,
      matchedChunks: 1,
      rows: [['chunk']],
      truncated: false,
    };
    expect(decodeResponse({ id: 1, kind: 'grepRows', result })).toEqual({
      id: 1,
      kind: 'grepRows',
      result,
    });
    expect(() =>
      decodeResponse({ id: 1, kind: 'grepRows', result: { ...result, rows: [[{}]] } })
    ).toThrow(TypeError);
    expect(() =>
      decodeResponse({ id: 1, kind: 'grepRows', result: { ...result, matchedChunks: -1 } })
    ).toThrow(TypeError);
    expect(() => decodeResponse({ id: 0, kind: 'ready' })).toThrow(TypeError);
    expect(() => decodeResponse({ bypass: true, id: 1, kind: 'ready' })).toThrow(TypeError);
  });

  it('refuses unbounded deadlines before acquiring a process', async () => {
    let spawns = 0;
    await expect(
      SqliteQueryClient.open({
        databasePath: '/index.sqlite',
        deadlineMs: Number.POSITIVE_INFINITY,
        spawn: () => {
          spawns += 1;
          throw new Error('must not spawn');
        },
        startupDeadlineMs: 1000,
      })
    ).rejects.toThrow('positive finite');
    expect(spawns).toBe(0);
  });
});
