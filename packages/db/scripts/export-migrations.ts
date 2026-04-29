#!/usr/bin/env npx tsx
/**
 * Export Drizzle Migrations to JSON
 *
 * This script reads drizzle-kit generated migrations and exports them
 * as a JSON file that can be bundled for browser execution.
 *
 * Usage: npx tsx scripts/export-migrations.ts
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Migration {
  hash: string;
  name: string;
  sql: string;
  version: string;
}

interface MigrationManifest {
  finalSnapshotColumnTypes: Record<string, Record<string, string>>;
  finalSnapshotTables: string[];
  generatedAt: string;
  migrations: Migration[];
  version: 1;
}

/**
 * Compute a cryptographic hash for migration content verification.
 * Uses SHA-256 for collision resistance and integrity verification.
 */
function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function extractMigrations(migrationsDir: string): Migration[] {
  const migrations: Migration[] = [];

  // Read the meta/_journal.json to get migration order
  const journalPath = join(migrationsDir, 'meta', '_journal.json');

  let journal: { entries: Array<{ idx: number; version: string; tag: string }> };
  try {
    journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Could not read migration journal at ${journalPath}`, { cause: error });
  }

  // Sort by index to ensure correct order
  const sortedEntries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  for (const entry of sortedEntries) {
    const sqlFile = join(migrationsDir, `${entry.tag}.sql`);
    try {
      const sql = readFileSync(sqlFile, 'utf-8');
      migrations.push({
        version: entry.version,
        name: entry.tag,
        sql,
        hash: computeHash(sql),
      });
    } catch {
      console.error(`Could not read migration file: ${sqlFile}`);
      process.exit(1);
    }
  }

  return migrations;
}

function extractFinalSnapshotTables(migrationsDir: string): string[] {
  const finalSnapshot = readFinalSnapshot(migrationsDir);

  return Object.values(finalSnapshot.tables ?? {})
    .map((table) => table.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function extractFinalSnapshotColumnTypes(migrationsDir: string): Record<string, Record<string, string>> {
  const finalSnapshot = readFinalSnapshot(migrationsDir);
  const columnTypes: Record<string, Record<string, string>> = {};

  const sortedTables = Object.values(finalSnapshot.tables ?? {}).sort((left, right) => {
    const leftName = typeof left.name === 'string' ? left.name : '';
    const rightName = typeof right.name === 'string' ? right.name : '';
    return leftName.localeCompare(rightName);
  });

  for (const table of sortedTables) {
    if (typeof table.name !== 'string' || table.name.length === 0) {
      continue;
    }

    const tableColumnTypes: Record<string, string> = {};
    const sortedColumns = Object.entries(table.columns ?? {}).sort(([leftName], [rightName]) =>
      leftName.localeCompare(rightName)
    );

    for (const [columnName, column] of sortedColumns) {
      if (typeof column.type === 'string' && column.type.length > 0) {
        tableColumnTypes[columnName] = column.type;
      }
    }

    columnTypes[table.name] = tableColumnTypes;
  }

  return columnTypes;
}

function readFinalSnapshot(migrationsDir: string): {
  tables?: Record<string, { columns?: Record<string, { type?: unknown }>; name?: unknown }>;
} {
  const journalPath = join(migrationsDir, 'meta', '_journal.json');

  let journal: { entries: Array<{ idx: number; tag: string }> };
  try {
    journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Could not read migration journal at ${journalPath}`, { cause: error });
  }

  const latestEntry = [...journal.entries].sort((a, b) => b.idx - a.idx)[0];

  if (!latestEntry) {
    return [];
  }

  const snapshotFileName = `${latestEntry.idx.toString().padStart(4, '0')}_snapshot.json`;
  const snapshotPath = join(migrationsDir, 'meta', snapshotFileName);

  try {
    return JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Could not read final migration snapshot at ${snapshotPath}`, {
      cause: error,
    });
  }
}

function main() {
  const packageRoot = resolve(import.meta.dirname, '..');
  const migrationsDir = join(packageRoot, 'drizzle');
  const outputPath = join(packageRoot, 'src', 'drizzle', 'migrations.json');

  console.log('Exporting migrations from:', migrationsDir);

  const migrations = extractMigrations(migrationsDir);
  const finalSnapshotTables = extractFinalSnapshotTables(migrationsDir);
  const finalSnapshotColumnTypes = extractFinalSnapshotColumnTypes(migrationsDir);

  const manifest: MigrationManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    finalSnapshotColumnTypes,
    finalSnapshotTables,
    migrations,
  };

  writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
  console.log(`Exported ${migrations.length} migrations to:`, outputPath);
  console.log('Migration versions:', migrations.map((m) => m.name).join(', '));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
