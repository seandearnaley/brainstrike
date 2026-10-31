import { describe, expect, it } from 'vitest';
import { SqliteQueryClient } from '../client.js';
import { queryMethods } from '../protocol.js';

const grep = {
  caseSensitive: true,
  isRegex: false,
  maxRows: 50,
  pattern: 'needle',
  rootIds: ['root'],
};
const identity = { storeId: 'a'.repeat(64) };

describe('SQLite query process boundary', () => {
  it('rejects unknown command fields, invalid row limits and malformed scopes', () => {
    expect(() =>
      queryMethods.open.params({ databasePath: '/index.sqlite', disableAuthorizer: true })
    ).toThrow(TypeError);
    for (const params of [
      { ...grep, maxRows: 201 },
      { ...grep, rootIds: [42] },
      { ...grep, sql: 'SELECT 1' },
      { ...grep, requirement: { kind: 'caller-vectors', symbol: 'add' } },
    ]) {
      expect(() => queryMethods.grep.params(params)).toThrow(TypeError);
    }
    expect(queryMethods.grep.params(grep)).toEqual(grep);
  });

  it('rejects malformed grep results', () => {
    const result = {
      columns: ['id'],
      identity,
      matchedChunks: 1,
      rows: [['chunk']],
      truncated: false,
    };
    expect(queryMethods.grep.result(result)).toEqual(result);
    expect(() => queryMethods.grep.result({ ...result, rows: [[{}]] })).toThrow(TypeError);
    expect(() => queryMethods.grep.result({ ...result, matchedChunks: -1 })).toThrow(TypeError);
    expect(() => queryMethods.grep.result({ ...result, bypass: true })).toThrow(TypeError);
    expect(() => queryMethods.open.result({ ready: true })).toThrow(TypeError);
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
