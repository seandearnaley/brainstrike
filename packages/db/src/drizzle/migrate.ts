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
import { migration027ViewFilterPresets } from '../migrations/027-view-filter-presets.js';
import { migration028GemmaLocalLlm } from '../migrations/028-gemma-local-llm.js';
import { migration030CollectionIndexingStats } from '../migrations/030-collection-indexing-stats.js';
import { migration032FileChunkSourceRanges } from '../migrations/032-file-chunk-source-ranges.js';
import { migration033UpdateProviderModels2026Frontier } from '../migrations/033-update-provider-models-2026-frontier.js';
import { migration034TsvectorGeneratedColumn } from '../migrations/034-tsvector-generated-column.js';
import { migration035Uuidv7PrimaryKeys } from '../migrations/035-uuidv7-primary-keys.js';
import { migration036WorkspaceIndexSystemRole } from '../migrations/036-workspace-index-system-role.js';
import { migration037FileRecordMtimeMs } from '../migrations/037-file-record-mtime-ms.js';
import type { Migration as LegacyMigration } from '../migrations/migration-runner.js';

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

function assertNoStaleDrizzleMigrationLedger(
  applied: ReadonlySet<string>,
  migrations: readonly Migration[]
): void {
  const knownHashes = new Set(migrations.map((migration) => migration.hash));
  const staleHashes = [...applied].filter((hash) => !knownHashes.has(hash));
  if (staleHashes.length === 0) {
    return;
  }

  throw new Error(
    `Brainstrike DB is greenfield; stale "${MIGRATIONS_TABLE}" databases must be reset instead of migrated. Unknown migration hashes (${staleHashes.length} stale out of ${applied.size} applied): ${staleHashes.join(', ')}`
  );
}

/**
 * Records a migration as applied
 */
async function recordMigration(db: PGlite, hash: string): Promise<void> {
  await db.query(`INSERT INTO "${MIGRATIONS_TABLE}" (hash) VALUES ($1)`, [hash]);
}

type SqlBackedMigration = LegacyMigration & {
  readonly up: string;
};

function isSqlBackedMigration(migration: LegacyMigration): migration is SqlBackedMigration {
  return typeof migration.up === 'string';
}

function customMigration(hash: string, migration: LegacyMigration): Migration {
  if (!isSqlBackedMigration(migration)) {
    throw new Error(`Drizzle migration "${migration.name}" must be a SQL string.`);
  }

  return {
    hash,
    name: migration.name,
    sql: migration.up,
    version: String(migration.version),
  };
}

// Append-only by design. Once a custom migration hash can be written to the
// Drizzle ledger, removing or rewriting it must make greenfield startup fail
// through the stale-hash guard rather than guessing a compatible history.
const customMigrations: Migration[] = [
  customMigration('custom-015-model-registry-seed', migration015ModelRegistry),
  customMigration('custom-020-local-llm-models', migration020LocalLlmModels),
  customMigration('custom-021-rename-transformers-to-local', migration021RenameTransformersToLocal),
  customMigration(
    'custom-022-enable-default-embedding-models',
    migration022EnableDefaultEmbeddingModels
  ),
  customMigration('custom-023-fix-local-provider-enabled', migration023FixLocalProviderEnabled),
  customMigration('custom-024-fix-llm-tool-calling', migration024FixLlmToolCalling),
  customMigration('custom-025-update-provider-models-2026', migration025UpdateProviderModels2026),
  customMigration(
    'custom-026-update-provider-models-2026-v2',
    migration026UpdateProviderModels2026V2
  ),
  customMigration('custom-027-view-filter-presets-seed', migration027ViewFilterPresets),
  customMigration('custom-028-gemma-local-llm', migration028GemmaLocalLlm),
  customMigration('custom-030-collection-indexing-stats', migration030CollectionIndexingStats),
  customMigration('custom-032-file-chunk-source-ranges', migration032FileChunkSourceRanges),
  customMigration(
    'custom-033-update-provider-models-2026-frontier',
    migration033UpdateProviderModels2026Frontier
  ),
  customMigration('custom-034-tsvector-generated-column', migration034TsvectorGeneratedColumn),
  customMigration('custom-035-uuidv7-primary-keys', migration035Uuidv7PrimaryKeys),
  customMigration('custom-036-workspace-index-system-role', migration036WorkspaceIndexSystemRole),
  customMigration('custom-037-file-record-mtime-ms', migration037FileRecordMtimeMs),
];

const DOLLAR_QUOTED_BLOCK_PLACEHOLDER_PREFIX = '__BRAINSTRIKE_DOLLAR_QUOTE_';

interface DollarQuotedBlockReplacement {
  readonly blocks: readonly string[];
  readonly sql: string;
}

interface SingleQuotedStringScanState {
  inSingleQuotedString: boolean;
  singleQuotedStringUsesBackslashEscapes: boolean;
}

function extractDollarQuotedBlocks(sql: string): DollarQuotedBlockReplacement {
  const blocks: string[] = [];
  let sanitizedSql = '';
  const state: SingleQuotedStringScanState = {
    inSingleQuotedString: false,
    singleQuotedStringUsesBackslashEscapes: false,
  };

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "'") {
      const nextIndex = consumeSingleQuote(sql, index, state);
      sanitizedSql += sql.slice(index, nextIndex + 1);
      index = nextIndex;
      continue;
    }

    if (
      state.inSingleQuotedString &&
      state.singleQuotedStringUsesBackslashEscapes &&
      char === '\\'
    ) {
      sanitizedSql += char;
      if (next !== undefined) {
        sanitizedSql += next;
        index += 1;
      }
      continue;
    }

    const openingTag = state.inSingleQuotedString ? null : readDollarQuoteTag(sql, index);
    if (openingTag !== null) {
      const closingTagIndex = sql.indexOf(openingTag, index + openingTag.length);
      if (closingTagIndex !== -1) {
        const blockEnd = closingTagIndex + openingTag.length;
        const block = sql.slice(index, blockEnd);
        const blockIndex = blocks.push(block) - 1;
        sanitizedSql += `${DOLLAR_QUOTED_BLOCK_PLACEHOLDER_PREFIX}${blockIndex}__`;
        index = blockEnd - 1;
        continue;
      }
      logger.warn('Malformed dollar-quoted block in migration SQL', {
        index,
        tag: openingTag,
      });
      const block = sql.slice(index);
      const blockIndex = blocks.push(block) - 1;
      sanitizedSql += `${DOLLAR_QUOTED_BLOCK_PLACEHOLDER_PREFIX}${blockIndex}__`;
      index = sql.length - 1;
      continue;
    }

    sanitizedSql += char;
  }

  return { blocks, sql: sanitizedSql };
}

function restoreDollarQuotedBlocks(sql: string, blocks: readonly string[]): string {
  return sql.replace(
    new RegExp(`${DOLLAR_QUOTED_BLOCK_PLACEHOLDER_PREFIX}(\\d+)__`, 'g'),
    (placeholder: string, index: string) => blocks[Number(index)] ?? placeholder
  );
}

function readDollarQuoteTag(input: string, index: number): string | null {
  if (input[index] !== '$') {
    return null;
  }

  const firstTagCharacter = input[index + 1];
  if (firstTagCharacter === '$') {
    return '$$';
  }
  if (firstTagCharacter === undefined || !/[A-Za-z_]/.test(firstTagCharacter)) {
    return null;
  }

  let cursor = index + 2;
  while (cursor < input.length && /[A-Za-z0-9_]/.test(input[cursor] ?? '')) {
    cursor += 1;
  }

  return input[cursor] === '$' ? input.slice(index, cursor + 1) : null;
}

function consumeSingleQuote(
  input: string,
  quoteIndex: number,
  state: SingleQuotedStringScanState
): number {
  const next = input[quoteIndex + 1];
  if (state.inSingleQuotedString && next === "'") {
    return quoteIndex + 1;
  }
  if (!state.inSingleQuotedString) {
    state.singleQuotedStringUsesBackslashEscapes = isEscapedSqlStringStart(input, quoteIndex);
  }
  state.inSingleQuotedString = !state.inSingleQuotedString;
  if (!state.inSingleQuotedString) {
    state.singleQuotedStringUsesBackslashEscapes = false;
  }
  return quoteIndex;
}

function isEscapedSqlStringStart(line: string, quoteIndex: number): boolean {
  if (quoteIndex === 0) {
    return false;
  }
  const prefix = line[quoteIndex - 1] ?? '';
  const prefixBefore = quoteIndex > 1 ? (line[quoteIndex - 2] ?? '') : '';
  return (
    (prefix === 'E' || prefix === 'e') && (quoteIndex === 1 || !/[A-Za-z0-9_]/.test(prefixBefore))
  );
}

function stripLineCommentFromLine(line: string): string {
  const state: SingleQuotedStringScanState = {
    inSingleQuotedString: false,
    singleQuotedStringUsesBackslashEscapes: false,
  };

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "'") {
      index = consumeSingleQuote(line, index, state);
      continue;
    }

    if (
      state.inSingleQuotedString &&
      state.singleQuotedStringUsesBackslashEscapes &&
      char === '\\'
    ) {
      index += 1;
      continue;
    }

    if (!state.inSingleQuotedString && char === '-' && next === '-') {
      return line.slice(0, index);
    }
  }

  return line;
}

/**
 * Splits migration SQL into individual statements
 * Handles the --> statement-breakpoint marker from drizzle-kit
 */
function stripLineComments(sql: string): string {
  return sql.split('\n').map(stripLineCommentFromLine).join('\n');
}

function splitSemicolonDelimitedStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  const state: SingleQuotedStringScanState = {
    inSingleQuotedString: false,
    singleQuotedStringUsesBackslashEscapes: false,
  };

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "'") {
      const nextIndex = consumeSingleQuote(sql, index, state);
      current += sql.slice(index, nextIndex + 1);
      index = nextIndex;
      continue;
    }

    if (
      state.inSingleQuotedString &&
      state.singleQuotedStringUsesBackslashEscapes &&
      char === '\\'
    ) {
      current += char;
      if (next !== undefined) {
        current += next;
        index += 1;
      }
      continue;
    }

    if (char === ';' && !state.inSingleQuotedString) {
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

export function splitMigrationStatements(sql: string): string[] {
  const { blocks, sql: sanitizedSql } = extractDollarQuotedBlocks(sql);

  return sanitizedSql
    .split('--> statement-breakpoint')
    .flatMap((block) => splitSemicolonDelimitedStatements(stripLineComments(block)))
    .map((statement) => restoreDollarQuotedBlocks(statement, blocks));
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

    const statements = splitMigrationStatements(migration.sql);
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
    const allMigrations = [...manifest.migrations, ...customMigrations];
    assertNoStaleDrizzleMigrationLedger(applied, allMigrations);

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
    assertNoStaleDrizzleMigrationLedger(applied, allMigrations);

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
