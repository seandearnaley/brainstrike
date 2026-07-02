import { BRAINSTRIKE_DB_EXECUTION_RUNTIME_KEY } from '@brainstrike/types';
import type {
  BrainstrikeDbClient,
  BrainstrikeDbExecutionClient,
  BrainstrikeDbRuntimeHost,
  BrainstrikeDbSqlCapabilities,
  BrainstrikeDbTransactionClient,
} from '../src/architecture/brainstrike-db-client-contract.js';
import {
  BRAINSTRIKE_DB_CLIENT_CAPABILITIES,
  BRAINSTRIKE_DB_EXECUTION_CLIENT_CAPABILITIES,
  BRAINSTRIKE_DB_POSTGRES_REPOSITORY_SQL_FEATURES,
  BRAINSTRIKE_DB_RUNTIME_HOST_CAPABILITIES,
  BRAINSTRIKE_DB_SQL_DIALECTS,
  BRAINSTRIKE_DB_TURSO_BASELINE_SQL_CAPABILITIES,
  buildBrainstrikeDbClientCapabilityBootstrapChecks,
  buildBrainstrikeDbExecutionClientCapabilityBootstrapChecks,
  buildBrainstrikeDbRuntimeHostCapabilityBootstrapChecks,
  buildBrainstrikeDbSqlFeatureBootstrapChecks,
  getBrainstrikeDbExecutionRuntime,
  getMissingBrainstrikeDbClientCapabilities,
  getMissingBrainstrikeDbExecutionClientCapabilities,
  getMissingBrainstrikeDbRuntimeHostCapabilities,
  getMissingBrainstrikeDbSqlFeatures,
  hasBrainstrikeDbSqlDialect,
  isTursoBrainstrikeDbExecutionClient,
  markBrainstrikeDbExecutionRuntime,
} from '../src/architecture/brainstrike-db-client-contract.js';

describe('Brainstrike DB client contract', () => {
  it('records the required cross-runtime execution capabilities separately from host lifecycle', () => {
    expect(BRAINSTRIKE_DB_CLIENT_CAPABILITIES).toEqual([
      'query',
      'exec',
      'transaction',
      'live-query',
    ]);
    expect(BRAINSTRIKE_DB_EXECUTION_CLIENT_CAPABILITIES).toEqual(['query', 'exec', 'transaction']);
    expect(BRAINSTRIKE_DB_SQL_DIALECTS).toEqual(['postgres', 'sqlite']);
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
    expect(getMissingBrainstrikeDbExecutionClientCapabilities(partialClient)).toEqual([
      'transaction',
    ]);
  });

  it('accepts a Turso-shaped owner as an execution client without requiring live query', () => {
    const txClient: BrainstrikeDbTransactionClient = {
      query: async <TRecord = unknown>() => ({ rows: [] as readonly TRecord[] }),
      exec: async () => undefined,
    };
    const tursoShapedOwner = {
      query: async <TRecord = unknown>() => ({ rows: [] as readonly TRecord[] }),
      exec: async () => undefined,
      transaction: async <TResult>(
        callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
      ) => callback(txClient),
      close: async () => undefined,
    } satisfies BrainstrikeDbExecutionClient & { readonly close: () => Promise<void> };

    expect(getMissingBrainstrikeDbExecutionClientCapabilities(tursoShapedOwner)).toEqual([]);
    expect(getMissingBrainstrikeDbClientCapabilities(tursoShapedOwner)).toEqual(['live-query']);
  });

  it('requires an explicit execution runtime marker instead of inferring from missing live query', () => {
    const txClient: BrainstrikeDbTransactionClient = {
      query: async <TRecord = unknown>() => ({ rows: [] as readonly TRecord[] }),
      exec: async () => undefined,
    };
    const executionClient = {
      capabilities: { liveQuery: false },
      query: txClient.query,
      exec: txClient.exec,
      transaction: async <TResult>(
        callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
      ) => callback(txClient),
    };

    expect(getBrainstrikeDbExecutionRuntime(executionClient)).toBeNull();
    expect(isTursoBrainstrikeDbExecutionClient(executionClient)).toBe(false);

    const markedClient = markBrainstrikeDbExecutionRuntime(executionClient, 'turso');

    expect(getBrainstrikeDbExecutionRuntime(markedClient)).toBe('turso');
    expect(isTursoBrainstrikeDbExecutionClient(markedClient)).toBe(true);
    const [runtimeSymbol] = Object.getOwnPropertySymbols(markedClient).filter(
      (symbol) => symbol.description === BRAINSTRIKE_DB_EXECUTION_RUNTIME_KEY
    );
    expect(runtimeSymbol).toBeDefined();
    expect(Object.getOwnPropertyDescriptor(markedClient, runtimeSymbol as symbol)).toMatchObject({
      enumerable: false,
      value: 'turso',
    });
  });

  it('does not treat Turso execution shape as Postgres repository compatibility', () => {
    const tursoSql = {
      dialect: 'sqlite',
      features: ['sqlite-json', 'sqlite-returning', 'turso-vector'],
    } satisfies BrainstrikeDbSqlCapabilities;

    expect(hasBrainstrikeDbSqlDialect(tursoSql, 'postgres')).toBe(false);
    expect(hasBrainstrikeDbSqlDialect(tursoSql, 'sqlite')).toBe(true);
    expect(
      getMissingBrainstrikeDbSqlFeatures(tursoSql, BRAINSTRIKE_DB_POSTGRES_REPOSITORY_SQL_FEATURES)
    ).toEqual(BRAINSTRIKE_DB_POSTGRES_REPOSITORY_SQL_FEATURES);
  });

  it('records the current Turso baseline as SQLite with no Postgres-only features', () => {
    expect(BRAINSTRIKE_DB_TURSO_BASELINE_SQL_CAPABILITIES).toEqual({
      dialect: 'sqlite',
      features: ['sqlite-json', 'sqlite-returning', 'turso-vector'],
    });
    expect(
      getMissingBrainstrikeDbSqlFeatures(
        BRAINSTRIKE_DB_TURSO_BASELINE_SQL_CAPABILITIES,
        BRAINSTRIKE_DB_POSTGRES_REPOSITORY_SQL_FEATURES
      )
    ).toEqual(BRAINSTRIKE_DB_POSTGRES_REPOSITORY_SQL_FEATURES);
  });

  it('rejects unknown SQL feature names instead of treating them as available', () => {
    const malformedSqlCapabilities = {
      dialect: 'sqlite',
      features: ['totally-made-up'],
    };

    expect(
      getMissingBrainstrikeDbSqlFeatures(malformedSqlCapabilities, ['totally-made-up' as never])
    ).toEqual(['totally-made-up']);
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

  it('turns DB client capability gaps into required bootstrap checks', () => {
    const partialClient = {
      query: async () => ({ rows: [] }),
      exec: async () => undefined,
    };

    expect(buildBrainstrikeDbClientCapabilityBootstrapChecks(partialClient)).toEqual([
      {
        id: 'db.client.query',
        label: 'DB client query capability',
        required: true,
        status: 'passed',
      },
      {
        id: 'db.client.exec',
        label: 'DB client exec capability',
        required: true,
        status: 'passed',
      },
      {
        id: 'db.client.transaction',
        label: 'DB client transaction capability',
        required: true,
        status: 'failed',
      },
      {
        id: 'db.client.live-query',
        label: 'DB client live-query capability',
        required: true,
        status: 'failed',
      },
    ]);
  });

  it('turns execution-client capability gaps into required bootstrap checks', () => {
    const partialClient = {
      query: async () => ({ rows: [] }),
      exec: async () => undefined,
    };

    expect(buildBrainstrikeDbExecutionClientCapabilityBootstrapChecks(partialClient)).toEqual([
      {
        id: 'db.execution-client.query',
        label: 'DB execution client query capability',
        required: true,
        status: 'passed',
      },
      {
        id: 'db.execution-client.exec',
        label: 'DB execution client exec capability',
        required: true,
        status: 'passed',
      },
      {
        id: 'db.execution-client.transaction',
        label: 'DB execution client transaction capability',
        required: true,
        status: 'failed',
      },
    ]);
  });

  it('turns SQL feature gaps into required bootstrap checks', () => {
    expect(
      buildBrainstrikeDbSqlFeatureBootstrapChecks(BRAINSTRIKE_DB_TURSO_BASELINE_SQL_CAPABILITIES, [
        'postgres-vector',
        'skip-locked',
      ])
    ).toEqual([
      {
        id: 'db.sql-feature.postgres-vector',
        label: 'DB SQL feature postgres-vector',
        required: true,
        status: 'failed',
      },
      {
        id: 'db.sql-feature.skip-locked',
        label: 'DB SQL feature skip-locked',
        required: true,
        status: 'failed',
      },
    ]);
  });

  it('turns runtime host capability gaps into required bootstrap checks', () => {
    const partialHost = {
      diagnostics: async () => ({ ok: true }),
    };

    expect(buildBrainstrikeDbRuntimeHostCapabilityBootstrapChecks(partialHost)).toEqual([
      {
        id: 'db.runtime-host.diagnostics',
        label: 'DB runtime host diagnostics capability',
        required: true,
        status: 'passed',
      },
      {
        id: 'db.runtime-host.reset',
        label: 'DB runtime host reset capability',
        required: true,
        status: 'failed',
      },
      {
        id: 'db.runtime-host.close',
        label: 'DB runtime host close capability',
        required: true,
        status: 'failed',
      },
    ]);
  });
});
