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
    const completeClient = {
      query: async () => ({ rows: [] }),
      exec: async () => undefined,
      transaction: async <T>(fn: () => Promise<T>) => fn(),
      live: {
        query: async () => ({
          initialResults: { rows: [] },
          refresh: async () => undefined,
          subscribe: () => undefined,
          unsubscribe: async () => undefined,
        }),
      },
      diagnostics: async () => ({}),
      reset: async () => undefined,
      close: async () => undefined,
    };

    expect(getMissingBrainstrikeDbClientCapabilities(completeClient)).toEqual([]);
  });
});
