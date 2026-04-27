import { getTableName } from 'drizzle-orm';
import {
  assertSingleProductionMigrationAuthority,
  getDbMigrationAuthoritySnapshot,
  getProviderModelCatalogSchemaAudit,
} from '../src/architecture/db-migration-authority.js';
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
    expect(audit.generatedManifestTables).toEqual(['model_registry']);
    expect(audit.status).toBe('drizzle-schema-reconciled-production-manifest-unreconciled');
  });
});
