import { describe, expect, it } from 'vitest';
import { SqliteQueryClient } from '../client.js';
import { decodeRequest, decodeResponse } from '../protocol.js';

describe('SQLite query process boundary', () => {
  it('rejects unknown command fields, invalid row limits and nonfinite bindings', () => {
    for (const message of [
      { databasePath: '/index.sqlite', disableAuthorizer: true, id: 1, kind: 'open' },
      { id: 1, kind: 'query', maxRows: 201, sql: 'SELECT 1', values: [] },
      { id: 1, kind: 'query', maxRows: 50, sql: 'SELECT ?', values: [Number.NaN] },
    ]) {
      expect(() => decodeRequest(message)).toThrow(TypeError);
    }
  });

  it('decodes explicit caller-vector requirements and refuses malformed capability requests', () => {
    const request = { id: 1, kind: 'query', maxRows: 50, sql: 'SELECT 1', values: [] };
    expect(
      decodeRequest({ ...request, requirement: { kind: 'caller-vectors', symbol: 'add' } })
    ).toMatchObject({ requirement: { kind: 'caller-vectors', symbol: 'add' } });
    for (const requirement of [
      { kind: 'other', symbol: 'add' },
      { kind: 'caller-vectors', symbol: ' ' },
      { disableAuthorizer: true, kind: 'caller-vectors', symbol: 'add' },
    ]) {
      expect(() => decodeRequest({ ...request, requirement })).toThrow(TypeError);
    }
  });

  it('rejects malformed and unrecognized child replies', () => {
    expect(() =>
      decodeResponse({
        id: 1,
        kind: 'rows',
        result: { columns: ['id'], rows: [[{}]], truncated: false },
      })
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
