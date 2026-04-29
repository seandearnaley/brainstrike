export type DbRuntimeBaselineDependencyId =
  | 'migration-authority'
  | 'schema-drift-audit'
  | 'shared-db-client-contract';

export type DbRuntimeBaselineWorkstream = 'drizzle-cutover' | 'web-pglite-worker';

export interface DbRuntimeBaseline {
  /**
   * This interface is intentionally a frozen architecture snapshot. When the
   * runtime baseline changes, update the type and value together so downstream
   * workstreams acknowledge the new state explicitly.
   */
  readonly desktop: {
    readonly owner: 'electron-utility-process';
    readonly storage: 'filesystem-backed-profile';
  };
  readonly migrations: {
    readonly drizzleIsProductionCanonical: true;
    readonly drizzleLedger: '__drizzle_migrations';
    readonly legacyLedgerPolicy: 'reset-required';
    readonly productionAuthority: 'drizzle-migration-runner';
    readonly productionLedger: '__drizzle_migrations';
  };
  readonly schemaDrift: readonly {
    readonly drizzleGeneratedManifestFinalTables: readonly string[];
    readonly drizzleSchemaTables: readonly string[];
    readonly id: string;
    readonly productionTables: readonly string[];
    readonly status: 'schema-and-manifest-reconciled';
  }[];
  readonly web: {
    readonly directPgliteScope: 'tests-memory-and-non-browser-utilities';
    readonly owner: 'pglite-worker-db-host';
    readonly storage: 'idb';
  };
}

export const BRAINSTRIKE_DB_RUNTIME_BASELINE: DbRuntimeBaseline = {
  desktop: {
    owner: 'electron-utility-process',
    storage: 'filesystem-backed-profile',
  },
  migrations: {
    drizzleIsProductionCanonical: true,
    drizzleLedger: '__drizzle_migrations',
    legacyLedgerPolicy: 'reset-required',
    productionAuthority: 'drizzle-migration-runner',
    productionLedger: '__drizzle_migrations',
  },
  schemaDrift: [
    {
      id: 'provider-model-catalog',
      productionTables: ['providers', 'models'],
      drizzleSchemaTables: ['providers', 'models'],
      drizzleGeneratedManifestFinalTables: ['providers', 'models'],
      status: 'schema-and-manifest-reconciled',
    },
  ],
  web: {
    directPgliteScope: 'tests-memory-and-non-browser-utilities',
    owner: 'pglite-worker-db-host',
    storage: 'idb',
  },
} as const;

const WORKSTREAM_DEPENDENCIES = {
  'drizzle-cutover': ['migration-authority', 'schema-drift-audit'],
  'web-pglite-worker': ['shared-db-client-contract', 'migration-authority', 'schema-drift-audit'],
} as const satisfies Record<DbRuntimeBaselineWorkstream, readonly DbRuntimeBaselineDependencyId[]>;

export function getDbRuntimeBaselineDependencyIds(
  workstream: DbRuntimeBaselineWorkstream
): readonly DbRuntimeBaselineDependencyId[] {
  return WORKSTREAM_DEPENDENCIES[workstream];
}
