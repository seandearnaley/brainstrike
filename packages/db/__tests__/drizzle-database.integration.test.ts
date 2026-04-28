import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { drizzleFromHandle } from '../src/drizzle/database.js';

describe('Drizzle database utilities integration', () => {
  it('executes Drizzle through an explicit raw worker-compatible client', async () => {
    const client = createWorkerCompatibleClient();
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

function createWorkerCompatibleClient(): WorkerCompatibleClient {
  const exec = vi.fn(async () => undefined);
  const query = vi.fn(
    async (
      _sql: string,
      _params?: readonly unknown[],
      _options?: QueryOptions
    ): Promise<{ readonly rows: readonly Record<string, unknown>[] }> => ({
      rows: [{ value: 1 }],
    })
  );
  const client: WorkerCompatibleClient = {
    exec,
    query,
    transaction: async <TResult>(callback: (tx: typeof client) => Promise<TResult>) =>
      await callback(client),
  };
  return client;
}
