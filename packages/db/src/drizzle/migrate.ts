/**
 * Drizzle Migration Runner for Browser + Electron
 *
 * This module provides migration execution that works in both
 * browser (no filesystem) and Electron (filesystem available) contexts.
 *
 * Migration SQL is bundled as JSON at build time via the export-migrations script.
 */

import type { PGlite } from '@electric-sql/pglite';

// Import the pre-compiled migrations manifest
// Using import attribute for Node.js 22+ ESM compatibility
import migrationsManifest from './migrations.json' with { type: 'json' };

type Migration = {
  version: string;
  name: string;
  sql: string;
  hash: string;
};

type MigrationManifest = {
  version: number;
  generatedAt: string;
  migrations: Migration[];
};

type MigrationResult = {
  success: boolean;
  appliedMigrations: string[];
  error?: string;
};

type AppliedMigration = {
  id: number;
  hash: string;
  created_at: Date;
};

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
    // Enable vector extension if requested
    if (enableVector) {
      await db.query('CREATE EXTENSION IF NOT EXISTS vector');
    }

    // Ensure migrations table exists
    await ensureMigrationsTable(db);

    // Get already applied migrations
    const applied = await getAppliedMigrations(db);

    // Load migrations from manifest
    const manifest = migrationsManifest as MigrationManifest;

    for (const migration of manifest.migrations) {
      // Skip if already applied
      if (applied.has(migration.hash)) {
        continue;
      }

      onMigrationStart?.(migration.name);

      // Split and execute each statement
      const statements = splitStatements(migration.sql);

      for (const statement of statements) {
        await db.query(statement);
      }

      // Record as applied
      await recordMigration(db, migration.hash);
      appliedMigrations.push(migration.name);

      onMigrationComplete?.(migration.name);
    }

    return {
      success: true,
      appliedMigrations,
    };
  } catch (error) {
    return {
      success: false,
      appliedMigrations,
      error: error instanceof Error ? error.message : String(error),
    };
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

  try {
    await ensureMigrationsTable(db);
    const applied = await getAppliedMigrations(db);

    const pending = manifest.migrations.filter((m) => !applied.has(m.hash)).map((m) => m.name);

    return {
      total: manifest.migrations.length,
      applied: applied.size,
      pending,
    };
  } catch {
    // Table doesn't exist yet, all migrations are pending
    return {
      total: manifest.migrations.length,
      applied: 0,
      pending: manifest.migrations.map((m) => m.name),
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
