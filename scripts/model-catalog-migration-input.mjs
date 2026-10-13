import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIGRATION_EXPORT_PATTERN =
  /export\s+const\s+(migration\d{3}[A-Za-z0-9_]*)\s*:\s*Migration\s*=/;

export function extractMigrationExportName(source) {
  return source.match(MIGRATION_EXPORT_PATTERN)?.[1] ?? null;
}

export async function readMigrationFiles(rootDir) {
  const dbRequire = createRequire(path.join(rootDir, 'packages/db/package.json'));
  const { tsImport } = dbRequire('tsx/esm/api');
  const migrationsDir = path.join(rootDir, 'packages/db/src/migrations');
  const entries = await readdir(migrationsDir);
  const migrationFiles = entries.filter((entry) => /^\d{3}-.*\.ts$/.test(entry)).sort();

  return Promise.all(
    migrationFiles.map(async (entry) => {
      const file = path.posix.join('packages/db/src/migrations', entry);
      const source = await readFile(path.join(rootDir, file), 'utf8');
      const exportName = extractMigrationExportName(source);
      if (!exportName) {
        return { file, source };
      }
      // Use the same public Migration object as the numbered/Drizzle manifest.
      // tsx is the DB package's existing TS tooling; source aliases prevent stale dist.
      const module = await tsImport(pathToFileURL(path.join(rootDir, file)).href, {
        parentURL: import.meta.url,
        tsconfig: path.join(rootDir, 'tsconfig.json'),
      });
      const migration = module[exportName];
      if (!(migration && ['string', 'function'].includes(typeof migration.up))) {
        throw new Error(`Invalid exported Migration: ${file}`);
      }
      // Historical callbacks are not executed by this static catalog check.
      return typeof migration.up === 'string'
        ? { file, source, upSql: migration.up }
        : { file, source };
    })
  );
}
