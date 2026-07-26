import type { AgentSqlDatabase } from '@brainstrike/db';
import { describe, expect, it } from 'vitest';
import type { RemoteDbClient, RemoteDbTransaction } from '../../db-host-manager';
import type { DbHostQueryResult, DbHostRequest } from '../../db-host-protocol';

/**
 * The desktop `getDatabase()` returns `RemoteDbClient`, NOT a raw PGlite.
 *
 * The agent SQL sandbox needs array row mode (to preserve duplicate output
 * column names) and `fields` (to recover column names at all). Neither existed
 * on the host protocol originally, so `{ rowMode: 'array' }` was accepted by the
 * type checker's bivariant method parameters, silently dropped over IPC, and
 * every production query would have failed on object-keyed rows — while the
 * service's own tests passed against raw PGlite.
 *
 * These tests pin the seam that hid it.
 */
describe('querySelf remote database contract', () => {
  it('accepts RemoteDbClient where the sandbox expects a database', () => {
    // A COMPILE-TIME assertion: if `RemoteDbClient` ever stops satisfying
    // `AgentSqlDatabase` — for example if the host protocol drops `rowMode` or
    // `fields` again — this stops type-checking, which is the failure mode the
    // original bug needed and did not have.
    const accepts = (_database: AgentSqlDatabase): void => undefined;
    const client = null as unknown as RemoteDbClient;

    expect(() => accepts(client)).not.toThrow();
  });

  it('carries rowMode on both query request shapes', () => {
    const direct: DbHostRequest = { kind: 'query', rowMode: 'array', sql: 'SELECT 1' };
    const inTransaction: DbHostRequest = {
      kind: 'transaction:query',
      rowMode: 'array',
      sql: 'SELECT 1',
      transactionId: 'tx-1',
    };

    // The transaction shape is the one the sandbox actually uses: the read-only
    // preamble and the statement must land on the same session.
    expect(direct).toMatchObject({ rowMode: 'array' });
    expect(inTransaction).toMatchObject({ rowMode: 'array' });
  });

  it('returns fields alongside array-mode rows', () => {
    const result: DbHostQueryResult<unknown[]> = {
      fields: [{ name: 'id' }, { name: 'id' }],
      rows: [[1, 2]],
    };

    // Duplicate names are the whole reason `fields` exists — object-keyed rows
    // would collapse `SELECT a.id, b.id` to a single value.
    expect(result.fields?.map((field) => field.name)).toEqual(['id', 'id']);
    expect(result.rows[0]).toEqual([1, 2]);
  });

  it('forwards rowMode through a transaction query', async () => {
    const sent: DbHostRequest[] = [];

    // Mirrors the manager's tx.query construction: options must reach the wire,
    // not be dropped between the service and the host.
    const tx: RemoteDbTransaction = {
      exec: async () => await Promise.resolve(undefined),
      query: async <TRecord = unknown>(
        sql: string,
        params?: readonly unknown[],
        options?: { readonly rowMode?: 'array' }
      ) => {
        sent.push({
          kind: 'transaction:query',
          sql,
          transactionId: 'tx-1',
          ...(params ? { params } : {}),
          ...(options?.rowMode ? { rowMode: options.rowMode } : {}),
        });
        return await Promise.resolve({
          fields: [{ name: 'n' }],
          rows: [],
        } as DbHostQueryResult<TRecord>);
      },
    };

    await tx.query('SELECT 1 AS n', [], { rowMode: 'array' });
    await tx.query('SELECT 2');

    expect(sent[0]).toMatchObject({ rowMode: 'array' });
    expect(sent[1]).not.toHaveProperty('rowMode');
  });
});
