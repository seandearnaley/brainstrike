import { getTableName } from 'drizzle-orm';
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
  readonly generatedManifestTables: readonly ['model_registry'];
  readonly productionTables: readonly ['providers', 'models'];
  readonly status: 'drizzle-schema-reconciled-production-manifest-unreconciled';
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

  if (drizzleSchemaTables[0] !== 'providers' || drizzleSchemaTables[1] !== 'models') {
    throw new Error(
      `Provider/model Drizzle schema drifted from production tables: ${drizzleSchemaTables.join(
        ', '
      )}.`
    );
  }

  return {
    drizzleSchemaTables: ['providers', 'models'],
    generatedManifestTables: ['model_registry'],
    productionTables: ['providers', 'models'],
    status: 'drizzle-schema-reconciled-production-manifest-unreconciled',
  };
}
