import type {
  BrainstrikeDbClient,
  BrainstrikeDbTransactionClient,
} from '../src/architecture/brainstrike-db-client-contract.js';
import {
  BRAINSTRIKE_DB_CLIENT_CAPABILITIES,
  getMissingBrainstrikeDbClientCapabilities,
} from '../src/architecture/brainstrike-db-client-contract.js';

describe('Brainstrike DB client contract', () => {
  it('records the required cross-runtime capabilities', () => {
    expect(BRAINSTRIKE_DB_CLIENT_CAPABILITIES).toEqual([
      'query',
      'exec',
      'transaction',
      'live-query',
      'diagnostics',
      'reset',
      'close',
    ]);
  });

  it('reports missing capabilities instead of treating partial clients as compatible', () => {
    const partialClient = {
      query: async () => ({ rows: [] }),
      exec: async () => undefined,
    };

    expect(getMissingBrainstrikeDbClientCapabilities(partialClient)).toEqual([
      'transaction',
      'live-query',
      'diagnostics',
      'reset',
      'close',
    ]);
  });

  it('accepts a complete structural client', () => {
    const txClient: BrainstrikeDbTransactionClient = {
      query: async <TRecord = unknown>() => ({ rows: [] as readonly TRecord[] }),
      exec: async () => undefined,
    };

    const completeClient = {
      ...txClient,
      transaction: async <TResult>(
        callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
      ) => callback(txClient),
      live: {
        query: async <TRecord = unknown>() => ({
          initialResults: { rows: [] as readonly TRecord[] },
          refresh: async () => undefined,
          subscribe: () => () => undefined,
          dispose: async () => undefined,
        }),
      },
      diagnostics: async () => ({ ok: true }),
      reset: async () => undefined,
      close: async () => undefined,
    } satisfies BrainstrikeDbClient;

    expect(getMissingBrainstrikeDbClientCapabilities(completeClient)).toEqual([]);
  });
});
