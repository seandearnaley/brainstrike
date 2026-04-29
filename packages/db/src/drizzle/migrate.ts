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
import { assertNoLegacyMigrationLedger } from '../architecture/db-migration-authority.js';
import { migration015ModelRegistry } from '../migrations/015-model-registry.js';
import { migration020LocalLlmModels } from '../migrations/020-local-llm-models.js';
import { migration021RenameTransformersToLocal } from '../migrations/021-rename-transformers-to-local.js';
import { migration022EnableDefaultEmbeddingModels } from '../migrations/022-enable-default-embedding-models.js';
import { migration023FixLocalProviderEnabled } from '../migrations/023-fix-local-provider-enabled.js';
import { migration024FixLlmToolCalling } from '../migrations/024-fix-llm-tool-calling.js';
import { migration025UpdateProviderModels2026 } from '../migrations/025-update-provider-models-2026.js';
import { migration026UpdateProviderModels2026V2 } from '../migrations/026-update-provider-models-2026-v2.js';
import { migration028GemmaLocalLlm } from '../migrations/028-gemma-local-llm.js';
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
    hash: 'custom-015-model-registry-seed',
    name: migration015ModelRegistry.name,
    sql: requireStringMigrationSql(migration015ModelRegistry.name, migration015ModelRegistry.up),
    version: String(migration015ModelRegistry.version),
  },
  {
    hash: 'custom-020-local-llm-models',
    name: migration020LocalLlmModels.name,
    sql: requireStringMigrationSql(migration020LocalLlmModels.name, migration020LocalLlmModels.up),
    version: String(migration020LocalLlmModels.version),
  },
  {
    hash: 'custom-021-rename-transformers-to-local',
    name: migration021RenameTransformersToLocal.name,
    sql: requireStringMigrationSql(
      migration021RenameTransformersToLocal.name,
      migration021RenameTransformersToLocal.up
    ),
    version: String(migration021RenameTransformersToLocal.version),
  },
  {
    hash: 'custom-022-enable-default-embedding-models',
    name: migration022EnableDefaultEmbeddingModels.name,
    sql: requireStringMigrationSql(
      migration022EnableDefaultEmbeddingModels.name,
      migration022EnableDefaultEmbeddingModels.up
    ),
    version: String(migration022EnableDefaultEmbeddingModels.version),
  },
  {
    hash: 'custom-023-fix-local-provider-enabled',
    name: migration023FixLocalProviderEnabled.name,
    sql: requireStringMigrationSql(
      migration023FixLocalProviderEnabled.name,
      migration023FixLocalProviderEnabled.up
    ),
    version: String(migration023FixLocalProviderEnabled.version),
  },
  {
    hash: 'custom-024-fix-llm-tool-calling',
    name: migration024FixLlmToolCalling.name,
    sql: requireStringMigrationSql(
      migration024FixLlmToolCalling.name,
      migration024FixLlmToolCalling.up
    ),
    version: String(migration024FixLlmToolCalling.version),
  },
  {
    hash: 'custom-025-update-provider-models-2026',
    name: migration025UpdateProviderModels2026.name,
    sql: requireStringMigrationSql(
      migration025UpdateProviderModels2026.name,
      migration025UpdateProviderModels2026.up
    ),
    version: String(migration025UpdateProviderModels2026.version),
  },
  {
    hash: 'custom-026-update-provider-models-2026-v2',
    name: migration026UpdateProviderModels2026V2.name,
    sql: requireStringMigrationSql(
      migration026UpdateProviderModels2026V2.name,
      migration026UpdateProviderModels2026V2.up
    ),
    version: String(migration026UpdateProviderModels2026V2.version),
  },
  {
    hash: 'custom-028-gemma-local-llm',
    name: migration028GemmaLocalLlm.name,
    sql: requireStringMigrationSql(migration028GemmaLocalLlm.name, migration028GemmaLocalLlm.up),
    version: String(migration028GemmaLocalLlm.version),
  },
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
function stripLineComments(sql: string): string {
  let result = '';
  let inSingleQuotedString = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (!inSingleQuotedString && char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') {
        index += 1;
      }
      result += '\n';
      continue;
    }

    if (char === "'") {
      result += char;
      if (inSingleQuotedString && next === "'") {
        result += next;
        index += 1;
        continue;
      }
      inSingleQuotedString = !inSingleQuotedString;
      continue;
    }

    result += char;
  }

  return result;
}

function splitSemicolonDelimitedStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingleQuotedString = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "'") {
      current += char;
      if (inSingleQuotedString && next === "'") {
        current += next;
        index += 1;
        continue;
      }
      inSingleQuotedString = !inSingleQuotedString;
      continue;
    }

    if (char === ';' && !inSingleQuotedString) {
      const statement = current.trim();
      if (statement.length > 0) {
        statements.push(statement);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const statement = current.trim();
  return statement.length > 0 ? [...statements, statement] : statements;
}

function splitStatements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .flatMap((block) => splitSemicolonDelimitedStatements(stripLineComments(block)));
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }

  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isMissingDrizzleMigrationsLedgerError(error: unknown): boolean {
  const code = getErrorCode(error);
  const message = getErrorMessage(error);

  if (code !== null) {
    return code === '42P01' && message.includes(MIGRATIONS_TABLE);
  }

  return (
    message.includes(`relation "${MIGRATIONS_TABLE}" does not exist`) ||
    message.includes(`table "${MIGRATIONS_TABLE}" does not exist`) ||
    message.includes(`no such table: ${MIGRATIONS_TABLE}`)
  );
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
    await assertNoLegacyMigrationLedger(db);

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

  await assertNoLegacyMigrationLedger(db);

  try {
    await ensureMigrationsTable(db);
    const applied = await getAppliedMigrations(db);

    const pending = allMigrations.filter((m) => !applied.has(m.hash)).map((m) => m.name);

    return {
      total: allMigrations.length,
      applied: applied.size,
      pending,
    };
  } catch (error) {
    if (!isMissingDrizzleMigrationsLedgerError(error)) {
      throw error;
    }

    // Ledger table is absent, so no Drizzle validation migrations have been recorded.
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
