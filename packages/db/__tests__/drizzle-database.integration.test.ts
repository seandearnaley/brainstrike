import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { drizzleFromHandle, markPGliteDrizzleCompatible } from '../src/drizzle/database.js';

describe('Drizzle database utilities integration', () => {
  it('executes Drizzle through an explicit raw worker-compatible client', async () => {
    const client = markPGliteDrizzleCompatible(createWorkerCompatibleClient());
    const drizzleDb = drizzleFromHandle({ raw: client });

    expect(drizzleDb).not.toBeNull();
    if (!drizzleDb) {
      return;
    }

    await drizzleDb.execute(sql`select ${1} as value`);

    expect(client.query).toHaveBeenCalledWith(
      'select $1 as value',
      [1],
      expect.objectContaining({ rowMode: 'object' })
    );
  });

  it('propagates query errors from the raw worker-compatible client', async () => {
    const client = markPGliteDrizzleCompatible(
      createWorkerCompatibleClient({
        onQuery: async () => {
          throw new Error('worker query failed');
        },
      })
    );
    const drizzleDb = drizzleFromHandle({ raw: client });

    expect(drizzleDb).not.toBeNull();
    if (!drizzleDb) {
      return;
    }

    try {
      await drizzleDb.execute(sql`select ${1}`);
      throw new Error('Expected Drizzle query to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Failed query: select $1');
      const cause = (error as { readonly cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toBe('worker query failed');
    }
  });

  it('routes transaction callback failures through the raw worker-compatible client', async () => {
    const rollbackEvents: string[] = [];
    const client = markPGliteDrizzleCompatible(
      createWorkerCompatibleClient({
        onTransactionRollback: () => rollbackEvents.push('rollback'),
      })
    );
    const drizzleDb = drizzleFromHandle({ raw: client });

    expect(drizzleDb).not.toBeNull();
    if (!drizzleDb) {
      return;
    }

    // The real PGlite/PGliteWorker client owns transactional integrity. This
    // bridge test proves Drizzle routes callback failures through that client.
    await expect(
      drizzleDb.transaction(async (tx) => {
        await tx.execute(sql`insert into job_queue (id) values (${1})`);
        throw new Error('rollback requested');
      })
    ).rejects.toThrow('rollback requested');

    expect(client.query).toHaveBeenCalledWith(
      'insert into job_queue (id) values ($1)',
      [1],
      expect.objectContaining({ rowMode: 'object' })
    );
    expect(rollbackEvents).toEqual(['rollback']);
  });
});

interface QueryOptions {
  readonly parsers?: Record<number, (value: string) => string>;
  readonly rowMode?: 'array' | 'object';
}

interface WorkerCompatibleClient {
  readonly exec: () => Promise<void>;
  readonly query: (
    sql: string,
    params?: readonly unknown[],
    options?: QueryOptions
  ) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  readonly transaction: <TResult>(
    callback: (tx: WorkerCompatibleClient) => Promise<TResult>
  ) => Promise<TResult>;
}

interface WorkerCompatibleClientOptions {
  readonly onQuery?: (
    sql: string,
    params?: readonly unknown[],
    options?: QueryOptions
  ) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  readonly onTransactionRollback?: () => void;
}

function createWorkerCompatibleClient(
  options: WorkerCompatibleClientOptions = {}
): WorkerCompatibleClient {
  const exec = vi.fn(async () => undefined);
  const query = vi.fn(
    async (
      sql: string,
      params?: readonly unknown[],
      queryOptions?: QueryOptions
    ): Promise<{ readonly rows: readonly Record<string, unknown>[] }> => {
      if (options.onQuery) {
        return await options.onQuery(sql, params, queryOptions);
      }
      return {
        rows: [{ value: 1 }],
      };
    }
  );
  const client: WorkerCompatibleClient = {
    exec,
    query,
    transaction: async <TResult>(callback: (tx: typeof client) => Promise<TResult>) => {
      try {
        return await callback(client);
      } catch (error) {
        options.onTransactionRollback?.();
        throw error;
      }
    },
  };
  return client;
}
