#!/usr/bin/env npx tsx
/**
 * Export Drizzle Migrations to JSON
 *
 * This script reads drizzle-kit generated migrations and exports them
 * as a JSON file that can be bundled for browser execution.
 *
 * Usage: npx tsx scripts/export-migrations.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Migration = {
  version: string;
  name: string;
  sql: string;
  hash: string;
};

type MigrationManifest = {
  version: 1;
  generatedAt: string;
  migrations: Migration[];
};

function computeHash(content: string): string {
  // Simple hash for migration content verification
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash &= hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

function extractMigrations(migrationsDir: string): Migration[] {
  const migrations: Migration[] = [];

  // Read the meta/_journal.json to get migration order
  const journalPath = join(migrationsDir, 'meta', '_journal.json');

  let journal: { entries: Array<{ idx: number; version: string; tag: string }> };
  try {
    journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
  } catch {
    console.error('Could not read migration journal at:', journalPath);
    process.exit(1);
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

function main() {
  const packageRoot = resolve(import.meta.dirname, '..');
  const migrationsDir = join(packageRoot, 'drizzle');
  const outputPath = join(packageRoot, 'src', 'drizzle', 'migrations.json');

  console.log('Exporting migrations from:', migrationsDir);

  const migrations = extractMigrations(migrationsDir);

  const manifest: MigrationManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    migrations,
  };

  writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
  console.log(`Exported ${migrations.length} migrations to:`, outputPath);
  console.log('Migration versions:', migrations.map((m) => m.name).join(', '));
}

main();
