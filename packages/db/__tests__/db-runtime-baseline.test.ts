import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRAINSTRIKE_DB_RUNTIME_BASELINE,
  getDbRuntimeBaselineDependencyIds,
} from '../src/architecture/db-runtime-baseline.js';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('Brainstrike DB runtime baseline', () => {
  it('records the current desktop and web DB ownership model', () => {
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.desktop.owner).toBe('electron-utility-process');
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.desktop.storage).toBe('filesystem-backed-profile');
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.web.owner).toBe('pglite-worker-db-host');
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.web.directPgliteScope).toBe(
      'tests-memory-and-non-browser-utilities'
    );
  });

  it('records that Drizzle migrations are blocked from production authority until compatible', () => {
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.migrations.productionAuthority).toBe(
      'legacy-migration-runner'
    );
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.migrations.productionLedger).toBe('_migrations');
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.migrations.drizzleLedger).toBe('__drizzle_migrations');
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.migrations.drizzlePromotionGate).toBe(
      'blocked-by-production-schema-drift'
    );
    expect(BRAINSTRIKE_DB_RUNTIME_BASELINE.migrations.drizzleIsProductionCanonical).toBe(false);
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

  it('has an architecture note matching the coded baseline', () => {
    const docsPath = resolve(
      testDir,
      '../../../apps/docs/docs/architecture/pglite-drizzle-db-contract.md'
    );
    expect(
      existsSync(docsPath),
      'Architecture doc must exist at apps/docs/docs/architecture/pglite-drizzle-db-contract.md'
    ).toBe(true);
    const doc = readFileSync(docsPath, 'utf8');

    expect(doc).toContain('utilityProcess DB host');
    expect(doc).toContain('Web owns PGlite in a browser PGliteWorker DB host');
    expect(doc).toContain('Direct PGlite remains scoped to tests, memory-only databases');
    expect(doc).toContain('legacy MigrationRunner remains the production migration authority');
    expect(doc).toContain('Drizzle migration runner remains schema-validation-only');
    expect(doc).toContain('blocked-by-production-schema-drift');
    expect(doc).toContain('_migrations');
    expect(doc).toContain('__drizzle_migrations');
    expect(doc).toContain('The execution client covers:');
    expect(doc).toContain('The runtime host covers:');
    expect(doc).toContain('providers/models');
    expect(doc).toContain('Drizzle schema now maps the production `providers/models` tables');
    expect(doc).toContain('generated Drizzle migration manifest now ends with `providers/models`');
    expect(doc).toContain('`drizzle-orm` is pinned to exact `0.45.2`');
  });
});
