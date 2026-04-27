import type { PGlite } from '@electric-sql/pglite';
import { getTableName } from 'drizzle-orm';
import migrationsManifest from '../drizzle/migrations.json' with { type: 'json' };
import { models, providers } from '../schema/index.js';

export type DbMigrationAuthorityId = 'drizzle-migration-runner' | 'legacy-migration-runner';

export type DbMigrationAuthorityStatus = 'production-canonical' | 'schema-validation-only';

export interface DbMigrationAuthorityRecord {
  readonly allowedProductionUse: boolean;
  readonly id: DbMigrationAuthorityId;
  readonly ledger: '_migrations' | '__drizzle_migrations';
  readonly status: DbMigrationAuthorityStatus;
}

export interface DbMigrationAuthoritySnapshot {
  readonly nonProduction: readonly DbMigrationAuthorityRecord[];
  readonly production: DbMigrationAuthorityRecord;
}

export interface ProviderModelCatalogSchemaAudit {
  readonly drizzleSchemaTables: readonly ['providers', 'models'];
  readonly generatedManifestFinalTables: readonly ['providers', 'models'];
  readonly productionTables: readonly ['providers', 'models'];
  readonly status: 'drizzle-schema-and-manifest-reconciled';
}

const PRODUCTION_MIGRATION_AUTHORITY: DbMigrationAuthorityRecord = {
  allowedProductionUse: true,
  id: 'legacy-migration-runner',
  ledger: '_migrations',
  status: 'production-canonical',
};

const NON_PRODUCTION_MIGRATION_AUTHORITIES: readonly DbMigrationAuthorityRecord[] = [
  {
    allowedProductionUse: false,
    id: 'drizzle-migration-runner',
    ledger: '__drizzle_migrations',
    status: 'schema-validation-only',
  },
] as const;

export function getDbMigrationAuthoritySnapshot(): DbMigrationAuthoritySnapshot {
  return {
    nonProduction: NON_PRODUCTION_MIGRATION_AUTHORITIES,
    production: PRODUCTION_MIGRATION_AUTHORITY,
  };
}

export function assertSingleProductionMigrationAuthority(
  snapshot: DbMigrationAuthoritySnapshot = getDbMigrationAuthoritySnapshot()
): void {
  const authorities = [snapshot.production, ...snapshot.nonProduction];
  const productionAuthorities = authorities.filter((authority) => authority.allowedProductionUse);

  if (productionAuthorities.length !== 1) {
    throw new Error(
      `Expected exactly one production migration authority, found ${productionAuthorities.length}.`
    );
  }

  if (snapshot.production.status !== 'production-canonical') {
    throw new Error(`Production migration authority is not canonical: ${snapshot.production.id}.`);
  }

  const conflictingLedgers = new Set(
    snapshot.nonProduction
      .filter((authority) => authority.allowedProductionUse)
      .map((authority) => authority.ledger)
  );

  if (conflictingLedgers.size > 0) {
    throw new Error(
      `Non-production migration ledgers cannot be production-authorized: ${Array.from(
        conflictingLedgers
      ).join(', ')}.`
    );
  }
}

export function getProviderModelCatalogSchemaAudit(): ProviderModelCatalogSchemaAudit {
  const drizzleSchemaTables = [getTableName(providers), getTableName(models)];
  const finalSnapshotTables = new Set(migrationsManifest.finalSnapshotTables);
  const [schemaProvidersTable, schemaModelsTable] = drizzleSchemaTables;
  const generatedProvidersTable = migrationsManifest.finalSnapshotTables.find(
    (tableName) => tableName === 'providers'
  );
  const generatedModelsTable = migrationsManifest.finalSnapshotTables.find(
    (tableName) => tableName === 'models'
  );

  if (schemaProvidersTable !== 'providers' || schemaModelsTable !== 'models') {
    throw new Error(
      `Provider/model Drizzle schema drifted from production tables: ${drizzleSchemaTables.join(
        ', '
      )}.`
    );
  }

  if (generatedProvidersTable !== 'providers' || generatedModelsTable !== 'models') {
    throw new Error(
      `Provider/model Drizzle generated manifest drifted from production tables: ${Array.from(
        finalSnapshotTables
      ).join(', ')}.`
    );
  }

  if (finalSnapshotTables.has('model_registry')) {
    throw new Error('Provider/model Drizzle generated manifest still contains model_registry.');
  }

  return {
    drizzleSchemaTables: [schemaProvidersTable, schemaModelsTable],
    generatedManifestFinalTables: [generatedProvidersTable, generatedModelsTable],
    productionTables: ['providers', 'models'],
    status: 'drizzle-schema-and-manifest-reconciled',
  };
}

// This guard lives on the production bootstrap path. Drizzle migration execution remains
// schema-validation-only and is not part of runtime startup, so the inverse production-ledger
// guard belongs to any future Drizzle promotion instead of this production bootstrap path.
export async function assertNoConflictingMigrationLedger(db: Pick<PGlite, 'query'>): Promise<void> {
  const ledgers = await db.query<{ tablename: string }>(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename = '__drizzle_migrations'
  `);

  if (ledgers.rows.length > 0) {
    throw new Error(
      'Drizzle migration ledger "__drizzle_migrations" exists without an explicit migration bridge.'
    );
  }
}
