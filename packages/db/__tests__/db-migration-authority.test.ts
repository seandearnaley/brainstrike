import { getTableName } from 'drizzle-orm';
import {
  assertSingleProductionMigrationAuthority,
  getDbMigrationAuthoritySnapshot,
  getProviderModelCatalogSchemaAudit,
} from '../src/architecture/db-migration-authority.js';
import migrationsManifest from '../src/drizzle/migrations.json';
import { models, providers } from '../src/schema/index.js';

describe('DB migration authority', () => {
  it('keeps one production migration authority while Drizzle migrations remain non-production', () => {
    const snapshot = getDbMigrationAuthoritySnapshot();

    expect(snapshot.production.id).toBe('legacy-migration-runner');
    expect(snapshot.production.ledger).toBe('_migrations');
    expect(snapshot.nonProduction).toContainEqual({
      allowedProductionUse: false,
      id: 'drizzle-migration-runner',
      ledger: '__drizzle_migrations',
      status: 'schema-validation-only',
    });

    expect(() => assertSingleProductionMigrationAuthority(snapshot)).not.toThrow();
  });

  it('maps the Drizzle provider/model catalog schema to the production tables', () => {
    expect(getTableName(providers)).toBe('providers');
    expect(getTableName(models)).toBe('models');

    const audit = getProviderModelCatalogSchemaAudit();

    expect(audit.productionTables).toEqual(['providers', 'models']);
    expect(audit.drizzleSchemaTables).toEqual(['providers', 'models']);
    expect(audit.generatedManifestFinalTables).toEqual(['providers', 'models']);
    expect(audit.status).toBe('drizzle-schema-and-manifest-reconciled');
  });

  it('derives the generated manifest final tables from the exported Drizzle snapshot', () => {
    expect(migrationsManifest.finalSnapshotTables).toContain('providers');
    expect(migrationsManifest.finalSnapshotTables).toContain('models');
    expect(migrationsManifest.finalSnapshotTables).not.toContain('model_registry');
  });
});
