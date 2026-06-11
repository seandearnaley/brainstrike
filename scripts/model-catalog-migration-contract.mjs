#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIGRATION_EXPORT_PATTERN = /export\s+const\s+(migration\d{3}[A-Za-z0-9_]*)\s*:\s*Migration\s*=/;
// Keep this literal table list in sync with the model catalog schema. The check
// intentionally scans whole migration files, including down blocks/comments, so
// ambiguous catalog mentions fail closed instead of silently bypassing ledger checks.
const CATALOG_ROW_MUTATION_PATTERN =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:models|providers)"?\b/i;

function extractMigrationExportName(source) {
  return source.match(MIGRATION_EXPORT_PATTERN)?.[1] ?? null;
}

function extractMigrationArrayNames(source) {
  const match = source.match(/export\s+const\s+migrations\b[^=]*=\s*\[([\s\S]*?)\];/);
  if (!match) {
    return new Set();
  }

  return new Set(match[1].match(/\bmigration\d{3}[A-Za-z0-9_]*\b/g) ?? []);
}

function extractCustomMigrationNames(source) {
  const names = new Set();
  const pattern =
    /customMigration\(\s*['"][^'"]+['"]\s*,\s*(migration\d{3}[A-Za-z0-9_]*)/g;
  for (const match of source.matchAll(pattern)) {
    names.add(match[1]);
  }
  return names;
}

function summarizeMigrationFile(file) {
  const exportName = extractMigrationExportName(file.source);
  return {
    catalogMutating: CATALOG_ROW_MUTATION_PATTERN.test(file.source),
    exportName,
    file: file.file,
  };
}

export function analyzeModelCatalogMigrationContract(input) {
  const migrationNames = extractMigrationArrayNames(input.migrationIndexSource);
  const customMigrationNames = extractCustomMigrationNames(input.drizzleMigrateSource);
  const migrationSummaries = input.migrationFiles.map(summarizeMigrationFile);
  const migrationByName = new Map(
    migrationSummaries
      .filter((migration) => migration.exportName)
      .map((migration) => [migration.exportName, migration])
  );
  const failures = [];

  for (const migration of migrationSummaries) {
    if (migration.catalogMutating && !migration.exportName) {
      failures.push({
        file: migration.file,
        message: `Catalog-mutating migration in ${migration.file} has no recognizable \`export const migrationNNN: Migration =\` declaration; the contract checker cannot verify its registration.`,
      });
      continue;
    }

    if (!migration.catalogMutating) {
      continue;
    }

    if (!migrationNames.has(migration.exportName)) {
      failures.push({
        file: migration.file,
        message: `Catalog-mutating migration ${migration.exportName} is missing from packages/db/src/migrations/index.ts migrations.`,
      });
    }

    if (!customMigrationNames.has(migration.exportName)) {
      failures.push({
        file: migration.file,
        message: `Catalog-mutating migration ${migration.exportName} is missing from packages/db/src/drizzle/migrate.ts customMigrations.`,
      });
    }
  }

  for (const customMigrationName of customMigrationNames) {
    if (migrationNames.has(customMigrationName)) {
      continue;
    }

    failures.push({
      file: 'packages/db/src/drizzle/migrate.ts',
      message: `Custom migration ${customMigrationName} is missing from packages/db/src/migrations/index.ts migrations.`,
    });
  }

  return {
    catalogMutatingMigrations: migrationSummaries
      .filter((migration) => migration.catalogMutating)
      .map((migration) => migration.exportName ?? migration.file),
    customMigrations: [...customMigrationNames],
    failures,
    migrations: [...migrationNames],
    knownMigrationCount: migrationByName.size,
  };
}

async function readMigrationFiles(rootDir) {
  const migrationsDir = path.join(rootDir, 'packages/db/src/migrations');
  const entries = await readdir(migrationsDir);
  const migrationFiles = entries.filter((entry) => /^\d{3}-.*\.ts$/.test(entry)).sort();

  return Promise.all(
    migrationFiles.map(async (entry) => {
      const file = path.join('packages/db/src/migrations', entry);
      return {
        file,
        source: await readFile(path.join(rootDir, file), 'utf8'),
      };
    })
  );
}

export async function checkModelCatalogMigrationContract(rootDir = process.cwd()) {
  const [migrationFiles, migrationIndexSource, drizzleMigrateSource] = await Promise.all([
    readMigrationFiles(rootDir),
    readFile(path.join(rootDir, 'packages/db/src/migrations/index.ts'), 'utf8'),
    readFile(path.join(rootDir, 'packages/db/src/drizzle/migrate.ts'), 'utf8'),
  ]);

  return analyzeModelCatalogMigrationContract({
    drizzleMigrateSource,
    migrationFiles,
    migrationIndexSource,
  });
}

async function main() {
  const result = await checkModelCatalogMigrationContract();
  if (result.failures.length > 0) {
    console.error('Model catalog migration contract failed.');
    console.error(
      'Catalog row migrations must be registered in both the numbered migration runner and the real app custom Drizzle ledger.'
    );
    for (const failure of result.failures) {
      console.error(`- ${failure.file}: ${failure.message}`);
    }
    process.exit(1);
  }

  console.log(
    `Model catalog migration contract passed (${result.catalogMutatingMigrations.length} catalog-mutating migrations checked).`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
