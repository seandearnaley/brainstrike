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

export interface DrizzleProductionCompatibilityBlocker {
  readonly column: string;
  readonly drizzleType: string;
  readonly productionType: string;
  readonly reason: string;
  readonly table: string;
}

export interface DrizzleProductionCompatibilityAudit {
  readonly blockers: readonly DrizzleProductionCompatibilityBlocker[];
  readonly canPromote: boolean;
  readonly status: 'blocked-by-production-schema-drift' | 'schema-compatible';
}

export type DrizzleFinalSnapshotColumnTypes = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

const PRODUCTION_MIGRATION_AUTHORITY: DbMigrationAuthorityRecord = {
  allowedProductionUse: true,
  id: 'drizzle-migration-runner',
  ledger: '__drizzle_migrations',
  status: 'production-canonical',
};

const NON_PRODUCTION_MIGRATION_AUTHORITIES: readonly DbMigrationAuthorityRecord[] = [
  {
    allowedProductionUse: false,
    id: 'legacy-migration-runner',
    ledger: '_migrations',
    status: 'schema-validation-only',
  },
] as const;

const DRIZZLE_PRODUCTION_COMPATIBILITY_BLOCKERS = [
  {
    column: 'id',
    drizzleType: 'uuid',
    productionType: 'text',
    reason: 'runtime file and collection identifiers are arbitrary text, not UUIDs',
    table: 'file_records',
  },
  {
    column: 'id',
    drizzleType: 'uuid',
    productionType: 'text',
    reason: 'runtime file and collection identifiers are arbitrary text, not UUIDs',
    table: 'file_chunks',
  },
  {
    column: 'file_record_id',
    drizzleType: 'uuid',
    productionType: 'text',
    reason: 'chunk foreign keys reference text file record IDs in production',
    table: 'file_chunks',
  },
  {
    column: 'embedding_set_id',
    drizzleType: 'uuid',
    productionType: 'text',
    reason: 'collection references use text embedding set IDs in production',
    table: 'file_chunks',
  },
  {
    column: 'id',
    drizzleType: 'uuid',
    productionType: 'text',
    reason: 'runtime file and collection identifiers are arbitrary text, not UUIDs',
    table: 'embedding_sets',
  },
  {
    column: 'embedding_set_id',
    drizzleType: 'uuid',
    productionType: 'text',
    reason: 'collection references use text embedding set IDs in production',
    table: 'file_records',
  },
  {
    column: 'id',
    drizzleType: 'uuid',
    productionType: 'text',
    reason: 'queue job identifiers are generated and retried as text IDs',
    table: 'job_queue',
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
] as const satisfies readonly DrizzleProductionCompatibilityBlocker[];

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

export function getDrizzleProductionCompatibilityAuditForColumnTypes(
  finalSnapshotColumnTypes: DrizzleFinalSnapshotColumnTypes
): DrizzleProductionCompatibilityAudit {
  const blockers = DRIZZLE_PRODUCTION_COMPATIBILITY_BLOCKERS.filter((blocker) => {
    const generatedType = finalSnapshotColumnTypes[blocker.table]?.[blocker.column];

    // Missing generated metadata is unsafe for a promotion gate. Keep the blocker active
    // unless the generated final snapshot explicitly proves the production-compatible type.
    if (generatedType === undefined) {
      return true;
    }

    return generatedType !== blocker.productionType;
  });

  return {
    blockers,
    canPromote: blockers.length === 0,
    status: blockers.length === 0 ? 'schema-compatible' : 'blocked-by-production-schema-drift',
  };
}

export function getDrizzleProductionCompatibilityAudit(): DrizzleProductionCompatibilityAudit {
  return getDrizzleProductionCompatibilityAuditForColumnTypes(
    migrationsManifest.finalSnapshotColumnTypes
  );
}

export const GREENFIELD_LEGACY_MIGRATION_LEDGER_ERROR =
  'Brainstrike DB is greenfield; legacy "_migrations" databases must be reset instead of migrated.';

export async function assertNoLegacyMigrationLedger(db: Pick<PGlite, 'query'>): Promise<void> {
  const ledgers = await db.query<{ tablename: string }>(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename = '_migrations'
  `);

  if (ledgers.rows.length > 0) {
    throw new Error(GREENFIELD_LEGACY_MIGRATION_LEDGER_ERROR);
  }
}
