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
      exec: async () => undefined,
      query: async () => ({ rows: [] }),
    };

    expect(getMissingBrainstrikeDbClientCapabilities(partialClient)).toEqual([
      'transaction',
      'live-query',
    ]);
  });

  it('accepts a complete structural client', () => {
    const txClient: BrainstrikeDbTransactionClient = {
      exec: async () => undefined,
      query: async <TRecord = unknown>() => ({ rows: [] as readonly TRecord[] }),
    };

    const completeClient = {
      ...txClient,
      close: async () => undefined,
      diagnostics: async () => ({ ok: true }),
      live: {
        query: async <TRecord = unknown>() => ({
          dispose: async () => undefined,
          initialResults: { rows: [] as readonly TRecord[] },
          refresh: async () => undefined,
          subscribe: () => () => undefined,
        }),
      },
      reset: async () => undefined,
      transaction: async <TResult>(
        callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
      ) => callback(txClient),
    } satisfies BrainstrikeDbClient;

    expect(getMissingBrainstrikeDbClientCapabilities(completeClient)).toEqual([]);
  });

  it('reports missing host lifecycle capabilities separately from query execution', () => {
    const executionClient: BrainstrikeDbClient = {
      exec: async () => undefined,
      live: {
        query: async <TRecord = unknown>() => ({
          dispose: async () => undefined,
          initialResults: { rows: [] as readonly TRecord[] },
          refresh: async () => undefined,
          subscribe: () => () => undefined,
        }),
      },
      query: async <TRecord = unknown>() => ({ rows: [] as readonly TRecord[] }),
      transaction: async <TResult>(
        callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
      ) =>
        callback({
          exec: async () => undefined,
          query: async <TRecord = unknown>() => ({ rows: [] as readonly TRecord[] }),
        }),
    };

    expect(getMissingBrainstrikeDbRuntimeHostCapabilities(executionClient)).toEqual([
      'diagnostics',
      'reset',
      'close',
    ]);
  });

  it('accepts a runtime host that owns diagnostics, reset, and close without query methods', () => {
    const runtimeHost = {
      close: async () => undefined,
      diagnostics: async () => ({ ok: true }),
      reset: async () => undefined,
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
