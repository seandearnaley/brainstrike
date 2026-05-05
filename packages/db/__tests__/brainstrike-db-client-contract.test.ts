import type {
  BrainstrikeDbClient,
  BrainstrikeDbRuntimeHost,
  BrainstrikeDbTransactionClient,
} from '../src/architecture/brainstrike-db-client-contract.js';
import {
  BRAINSTRIKE_DB_CLIENT_CAPABILITIES,
  BRAINSTRIKE_DB_RUNTIME_HOST_CAPABILITIES,
  getMissingBrainstrikeDbClientCapabilities,
  getMissingBrainstrikeDbRuntimeHostCapabilities,
} from '../src/architecture/brainstrike-db-client-contract.js';

describe('Brainstrike DB client contract', () => {
  it('records the required cross-runtime execution capabilities separately from host lifecycle', () => {
    expect(BRAINSTRIKE_DB_CLIENT_CAPABILITIES).toEqual([
      'query',
      'exec',
      'transaction',
      'live-query',
    ]);
    expect(BRAINSTRIKE_DB_RUNTIME_HOST_CAPABILITIES).toEqual(['diagnostics', 'reset', 'close']);
  });

  it('reports missing capabilities instead of treating partial clients as compatible', () => {
    const partialClient = {
      query: async () => ({ rows: [] }),
      exec: async () => undefined,
    };

    expect(getMissingBrainstrikeDbClientCapabilities(partialClient)).toEqual([
      'transaction',
      'live-query',
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

  it('reports missing host lifecycle capabilities separately from query execution', () => {
    const executionClient: BrainstrikeDbClient = {
      query: async <TRecord = unknown>() => ({ rows: [] as readonly TRecord[] }),
      exec: async () => undefined,
      transaction: async <TResult>(
        callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
      ) =>
        callback({
          query: async <TRecord = unknown>() => ({ rows: [] as readonly TRecord[] }),
          exec: async () => undefined,
        }),
      live: {
        query: async <TRecord = unknown>() => ({
          initialResults: { rows: [] as readonly TRecord[] },
          refresh: async () => undefined,
          subscribe: () => () => undefined,
          dispose: async () => undefined,
        }),
      },
    };

    expect(getMissingBrainstrikeDbRuntimeHostCapabilities(executionClient)).toEqual([
      'diagnostics',
      'reset',
      'close',
    ]);
  });

  it('accepts a runtime host that owns diagnostics, reset, and close without query methods', () => {
    const runtimeHost = {
      diagnostics: async () => ({ ok: true }),
      reset: async () => undefined,
      close: async () => undefined,
    } satisfies BrainstrikeDbRuntimeHost;

    expect(getMissingBrainstrikeDbRuntimeHostCapabilities(runtimeHost)).toEqual([]);
    expect(getMissingBrainstrikeDbClientCapabilities(runtimeHost)).toEqual([
      'query',
      'exec',
      'transaction',
      'live-query',
    ]);
  });
});
