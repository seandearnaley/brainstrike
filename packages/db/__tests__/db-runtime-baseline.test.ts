import {
  BRAINSTRIKE_DB_RUNTIME_BASELINE,
  getDbRuntimeBaselineDependencyIds,
} from '../src/architecture/db-runtime-baseline.js';

describe('Brainstrike DB runtime baseline', () => {
  it('records the current desktop and web DB ownership model', () => {
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.desktop.owner).toBe('electron-utility-process');
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.desktop.storage).toBe('filesystem-backed-profile');
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.web.owner).toBe('pglite-worker-db-host');
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.web.storage).toBe('idb-default-opfs-ahp-opt-in');
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.web.directPgliteScope).toBe(
      'tests-memory-and-non-browser-utilities'
    );
  });

  it('records Drizzle as the greenfield production migration authority', () => {
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.migrations.productionAuthority).toBe(
      'drizzle-migration-runner'
    );
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.migrations.productionLedger).toBe(
      '__drizzle_migrations'
    );
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.migrations.drizzleLedger).toBe('__drizzle_migrations');
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.migrations.legacyLedgerPolicy).toBe('reset-required');
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.migrations.drizzleIsProductionCanonical).toBe(true);
  });

  it('records known schema drift between hand-authored migrations and Drizzle schema', () => {
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.schemaDrift).toContainEqual({
      id: 'provider-model-catalog',
      productionTables: ['providers', 'models'],
      drizzleGeneratedManifestFinalTables: ['providers', 'models'],
      drizzleSchemaTables: ['providers', 'models'],
      status: 'schema-and-manifest-reconciled',
    });
  });

  it('keeps web worker implementation blocked on the baseline dependencies', () => {
    expect(getDbRuntimeBaselineDependencyIds('web-pglite-worker')).toEqual([
      'shared-db-client-contract',
      'migration-authority',
      'schema-drift-audit',
    ]);
  });
});
