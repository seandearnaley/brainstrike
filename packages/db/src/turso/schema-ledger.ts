import { createHash } from 'node:crypto';
import type { BrainstrikeDbTransactionClient } from '../architecture/brainstrike-db-client-contract.js';

export const TURSO_SCHEMA_LEDGER_TABLE = 'brainstrike_turso_schema_ledger';
export const TURSO_FORBIDDEN_MIGRATION_LEDGER_TABLES = ['_migrations', '__drizzle_migrations'];

export interface TursoSchemaLedgerEntry {
  readonly appliedAt: string;
  readonly checksum: string;
  readonly version: number;
}

export async function assertNoPostgresMigrationLedgers(
  client: BrainstrikeDbTransactionClient
): Promise<void> {
  const forbidden = await findForbiddenMigrationLedgerTables(client);
  if (forbidden.length > 0) {
    throw new Error(
      `Turso schema baseline cannot run with Postgres/PGlite migration ledgers present: ${forbidden.join(', ')}.`
    );
  }
}

export async function ensureTursoSchemaLedger(
  client: BrainstrikeDbTransactionClient
): Promise<void> {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS ${TURSO_SCHEMA_LEDGER_TABLE} (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
}

export async function readTursoSchemaLedgerEntry(
  client: BrainstrikeDbTransactionClient,
  version: number
): Promise<TursoSchemaLedgerEntry | null> {
  const result = await client.query<{
    applied_at: string;
    checksum: string;
    version: number;
  }>(`SELECT version, checksum, applied_at FROM ${TURSO_SCHEMA_LEDGER_TABLE} WHERE version = ?`, [
    version,
  ]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    appliedAt: row.applied_at,
    checksum: row.checksum,
    version: row.version,
  };
}

export async function assertTursoSchemaLedgerHasNoUnknownVersions(
  client: BrainstrikeDbTransactionClient,
  knownVersions: readonly number[]
): Promise<void> {
  const result = await client.query<{ version: number }>(
    `SELECT version FROM ${TURSO_SCHEMA_LEDGER_TABLE} ORDER BY version`
  );
  const known = new Set(knownVersions);
  const unknown = result.rows.map((row) => row.version).filter((version) => !known.has(version));
  if (unknown.length > 0) {
    throw new Error(
      `Turso schema ledger contains unknown baseline versions: ${unknown.join(', ')}.`
    );
  }
}

export async function recordTursoSchemaLedgerEntry(
  client: BrainstrikeDbTransactionClient,
  entry: {
    readonly checksum: string;
    readonly version: number;
  }
): Promise<void> {
  await client.exec(`INSERT INTO ${TURSO_SCHEMA_LEDGER_TABLE} (version, checksum) VALUES (?, ?)`, [
    entry.version,
    entry.checksum,
  ]);
}

export function computeTursoSchemaChecksum(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n-- statement --\n')).digest('hex');
}

async function findForbiddenMigrationLedgerTables(
  client: BrainstrikeDbTransactionClient
): Promise<readonly string[]> {
  const placeholders = TURSO_FORBIDDEN_MIGRATION_LEDGER_TABLES.map(() => '?').join(', ');
  const result = await client.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders}) ORDER BY name`,
    TURSO_FORBIDDEN_MIGRATION_LEDGER_TABLES
  );
  return result.rows.map((row) => row.name);
}
