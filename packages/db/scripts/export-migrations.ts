#!/usr/bin/env npx tsx
/**
 * Export the drizzle-kit snapshot audit to JSON
 *
 * This script reads the drizzle-kit snapshot under `drizzle/meta/` and exports
 * the two projections `src/architecture/db-migration-authority.ts` audits:
 * the final snapshot's table names, and its column types.
 *
 * It no longer exports migration SQL. Production applies ONE step, the
 * current-schema DDL (`src/migrations/current-schema-ddl.ts`), and drizzle-kit
 * emits nothing on that path: the snapshot is deliberately drifted from
 * `src/schema/index.ts` and `db:generate` is blocked (ADR-0002, ADR-0020). The
 * drift itself is the thing worth auditing, which is all this manifest carries.
 *
 * Usage: npx tsx scripts/export-migrations.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface MigrationManifest {
  finalSnapshotColumnTypes: Record<string, Record<string, string>>;
  finalSnapshotTables: string[];
  generatedAt: string;
  version: 1;
}

interface DrizzleSnapshotTable {
  columns?: Record<string, { type?: unknown }>;
  name?: unknown;
}

interface DrizzleSnapshot {
  tables?: Record<string, DrizzleSnapshotTable>;
}

function extractFinalSnapshotTables(migrationsDir: string): string[] {
  const finalSnapshot = readFinalSnapshot(migrationsDir);

  return Object.values(finalSnapshot.tables ?? {})
    .map((table) => table.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function extractFinalSnapshotColumnTypes(
  migrationsDir: string
): Record<string, Record<string, string>> {
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

/**
 * The newest snapshot the journal names. The journal is kept (and the snapshots
 * with it) precisely so the drift it records stays auditable; the per-migration
 * `.sql` files it also indexes are gone, and nothing here reads them.
 */
function readFinalSnapshot(migrationsDir: string): DrizzleSnapshot {
  const journalPath = join(migrationsDir, 'meta', '_journal.json');

  let journal: { entries: Array<{ idx: number; tag: string }> };
  try {
    journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Could not read migration journal at ${journalPath}`, { cause: error });
  }

  const latestEntry = [...journal.entries].sort((a, b) => b.idx - a.idx)[0];

  if (!latestEntry) {
    throw new Error(`Migration journal at ${journalPath} names no snapshot to audit.`);
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

  console.log('Exporting drizzle snapshot audit from:', migrationsDir);

  const finalSnapshotTables = extractFinalSnapshotTables(migrationsDir);
  const finalSnapshotColumnTypes = extractFinalSnapshotColumnTypes(migrationsDir);

  const manifest: MigrationManifest = {
    finalSnapshotColumnTypes,
    finalSnapshotTables,
    generatedAt: new Date().toISOString(),
    version: 1,
  };

  writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
  console.log(`Exported ${finalSnapshotTables.length} snapshot tables to:`, outputPath);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
