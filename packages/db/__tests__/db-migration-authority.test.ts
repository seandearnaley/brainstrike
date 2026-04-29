import { getTableName } from 'drizzle-orm';
import {
  assertSingleProductionMigrationAuthority,
  getDbMigrationAuthoritySnapshot,
  getDrizzleProductionCompatibilityAudit,
  getDrizzleProductionCompatibilityAuditForColumnTypes,
  getProviderModelCatalogSchemaAudit,
} from '../src/architecture/db-migration-authority.js';
import migrationsManifest from '../src/drizzle/migrations.json';
import { models, providers } from '../src/schema/index.js';

describe('DB migration authority', () => {
  it('keeps the legacy runner as production authority until Drizzle is schema-compatible', () => {
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

  it('blocks Drizzle production promotion on concrete schema incompatibilities', () => {
    const audit = getDrizzleProductionCompatibilityAudit();

    expect(audit.canPromote).toBe(false);
    expect(audit.status).toBe('blocked-by-production-schema-drift');
    expect(audit.blockers).toEqual(
      expect.arrayContaining([
        {
          column: 'id',
          drizzleType: 'uuid',
          productionType: 'text',
          reason: 'runtime file and collection identifiers are arbitrary text, not UUIDs',
          table: 'file_records',
        },
        {
          column: 'payload',
          drizzleType: 'text',
          productionType: 'jsonb',
          reason: 'queue diagnostics and retry code use JSONB operators',
          table: 'job_queue',
        },
        {
          column: 'run_at',
          drizzleType: 'timestamp with time zone',
          productionType: 'text',
          reason: 'production queue scheduling stores portable text timestamps',
          table: 'job_queue',
        },
      ])
    );
  });

  it('keeps blockers active when generated snapshot columns are missing', () => {
    const audit = getDrizzleProductionCompatibilityAuditForColumnTypes({});

    expect(audit.canPromote).toBe(false);
    expect(audit.status).toBe('blocked-by-production-schema-drift');
    expect(audit.blockers).toContainEqual({
      column: 'id',
      drizzleType: 'uuid',
      productionType: 'text',
      reason: 'runtime file and collection identifiers are arbitrary text, not UUIDs',
      table: 'file_records',
    });
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

  it('exports final snapshot column types in deterministic order', () => {
    const tableNames = Object.keys(migrationsManifest.finalSnapshotColumnTypes);

    expect(tableNames).toEqual([...tableNames].sort((left, right) => left.localeCompare(right)));

    for (const columnTypes of Object.values(migrationsManifest.finalSnapshotColumnTypes)) {
      const columnNames = Object.keys(columnTypes);
      expect(columnNames).toEqual(
        [...columnNames].sort((left, right) => left.localeCompare(right))
      );
    }
  });
});
