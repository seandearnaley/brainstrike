/**
 * Drizzle Migration Runner for Browser + Electron
 *
 * This module provides migration execution that works in both
 * browser (no filesystem) and Electron (filesystem available) contexts.
 *
 * Migration SQL is bundled as JSON at build time via the export-migrations script.
 */

import { createLogger } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import { migration030CollectionIndexingStats } from '../migrations/030-collection-indexing-stats.js';

// Import the pre-compiled migrations manifest
// Using import attribute for Node.js 22+ ESM compatibility
import migrationsManifest from './migrations.json' with { type: 'json' };

const logger = createLogger('DrizzleMigrate');

interface Migration {
  hash: string;
  name: string;
  sql: string;
  version: string;
}

interface MigrationManifest {
  generatedAt: string;
  migrations: Migration[];
  version: number;
}

interface MigrationResult {
  appliedMigrations: string[];
  error?: string;
  success: boolean;
}

interface AppliedMigration {
  created_at: Date;
  hash: string;
  id: number;
}

const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * Ensures the migrations tracking table exists
 */
async function ensureMigrationsTable(db: PGlite): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
    )
  `);
}

/**
 * Gets the list of already applied migration hashes
 */
async function getAppliedMigrations(db: PGlite): Promise<Set<string>> {
  const result = await db.query<AppliedMigration>(`SELECT hash FROM "${MIGRATIONS_TABLE}"`);
  return new Set(result.rows.map((row) => row.hash));
}

/**
 * Records a migration as applied
 */
async function recordMigration(db: PGlite, hash: string): Promise<void> {
  await db.query(`INSERT INTO "${MIGRATIONS_TABLE}" (hash) VALUES ($1)`, [hash]);
}

function requireStringMigrationSql(
  name: string,
  sql: string | ((db: PGlite) => Promise<void>)
): string {
  if (typeof sql === 'string') {
    return sql;
  }
  throw new Error(`Drizzle migration "${name}" must be a SQL string.`);
}

const customMigrations: Migration[] = [
  {
    hash: 'custom-030-collection-indexing-stats',
    name: migration030CollectionIndexingStats.name,
    sql: requireStringMigrationSql(
      migration030CollectionIndexingStats.name,
      migration030CollectionIndexingStats.up
    ),
    version: String(migration030CollectionIndexingStats.version),
  },
];

/**
 * Splits migration SQL into individual statements
 * Handles the --> statement-breakpoint marker from drizzle-kit
 */
function splitStatements(sql: string): string[] {
  // drizzle-kit uses --> statement-breakpoint as delimiter
  return sql
    .split('--> statement-breakpoint')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

/**
 * Applies a single migration within a transaction.
 * Handles rollback on failure and preserves the original error.
 */
async function applySingleMigration(db: PGlite, migration: Migration): Promise<void> {
  try {
    await db.query('BEGIN');

    const statements = splitStatements(migration.sql);
    for (const statement of statements) {
      await db.query(statement);
    }

    await recordMigration(db, migration.hash);
    await db.query('COMMIT');
  } catch (migrationError) {
    // Attempt rollback on failure - preserve both errors if rollback also fails
    let rollbackFailed = false;
    let rollbackMessage = '';
    try {
      await db.query('ROLLBACK');
    } catch (rollbackError: unknown) {
      rollbackFailed = true;
      rollbackMessage =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      logger.error(`Failed to rollback migration "${migration.name}": ${rollbackMessage}`);
    }
    const errorMessage =
      migrationError instanceof Error ? migrationError.message : String(migrationError);

    // Include rollback error in thrown error if rollback also failed
    const fullErrorMessage = rollbackFailed
      ? `Migration "${migration.name}" failed: ${errorMessage}. Additionally, rollback failed: ${rollbackMessage}`
      : `Migration "${migration.name}" failed: ${errorMessage}`;
    throw new Error(fullErrorMessage);
  }
}

/**
 * Runs all pending migrations
 *
 * @param db - PGlite database instance
 * @param options - Optional configuration
 * @returns Result of migration execution
 */
export async function runMigrations(
  db: PGlite,
  options: {
    /** If true, creates vector extension before migrations */
    enableVector?: boolean;
    /** Called before each migration */
    onMigrationStart?: (name: string) => void;
    /** Called after each migration succeeds */
    onMigrationComplete?: (name: string) => void;
  } = {}
): Promise<MigrationResult> {
  const { enableVector = true, onMigrationStart, onMigrationComplete } = options;
  const appliedMigrations: string[] = [];

  try {
    if (enableVector) {
      await db.query('CREATE EXTENSION IF NOT EXISTS vector');
    }

    await ensureMigrationsTable(db);
    const applied = await getAppliedMigrations(db);
    const manifest = migrationsManifest as MigrationManifest;

    for (const migration of manifest.migrations) {
      if (applied.has(migration.hash)) {
        continue;
      }

      onMigrationStart?.(migration.name);
      await applySingleMigration(db, migration);
      appliedMigrations.push(migration.name);
      onMigrationComplete?.(migration.name);
    }

    for (const migration of customMigrations) {
      if (applied.has(migration.hash)) {
        continue;
      }

      onMigrationStart?.(migration.name);
      await applySingleMigration(db, migration);
      appliedMigrations.push(migration.name);
      onMigrationComplete?.(migration.name);
    }

    return { success: true, appliedMigrations };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, appliedMigrations, error: errorMessage };
  }
}

/**
 * Gets the current migration status
 */
export async function getMigrationStatus(db: PGlite): Promise<{
  total: number;
  applied: number;
  pending: string[];
}> {
  const manifest = migrationsManifest as MigrationManifest;
  const allMigrations = [...manifest.migrations, ...customMigrations];

  try {
    await ensureMigrationsTable(db);
    const applied = await getAppliedMigrations(db);

    const pending = allMigrations.filter((m) => !applied.has(m.hash)).map((m) => m.name);

    return {
      total: allMigrations.length,
      applied: applied.size,
      pending,
    };
  } catch {
    // Table doesn't exist yet, all migrations are pending
    return {
      total: allMigrations.length,
      applied: 0,
      pending: allMigrations.map((m) => m.name),
    };
  }
}

/**
 * Resets all migrations (for development/testing only)
 * WARNING: This will drop all tables!
 */
export async function resetMigrations(db: PGlite): Promise<void> {
  // Get all tables except the migrations table
  const tables = await db.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
  `);

  // Drop all tables (CASCADE to handle foreign keys)
  for (const { tablename } of tables.rows) {
    await db.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
  }
}

export type { Migration, MigrationManifest, MigrationResult };
