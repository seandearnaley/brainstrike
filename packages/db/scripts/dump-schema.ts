#!/usr/bin/env tsx
/**
 * Dumps the canonical schema (and seeded data) of a freshly constructed
 * Brainstrike database, for migration-collapse equivalence proofs.
 *
 * Both modes build an EMPTY in-memory cluster with the production engine
 * extension set and then construct the schema one way or the other:
 *
 *   --mode=migrations   the production bootstrap (`migrate()`), i.e. the drizzle
 *                       manifest followed by the derived custom migrations
 *   --mode=ddl          a single SQL file applied through the same statement
 *                       splitter the migration runner uses
 *
 * Usage:
 *   tsx scripts/dump-schema.ts --mode=migrations --out=<dir>
 *   tsx scripts/dump-schema.ts --mode=ddl --ddl=<file.sql> --out=<dir>
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { splitMigrationStatements } from '../src/drizzle/migrate.js';
import { migrate } from '../src/migrations/bootstrap.js';
import { createEnginePglite } from '../src/pglite-factory.js';
import { dumpRowCounts, dumpSchema, dumpSeedData } from '../src/schema-snapshot/introspect.js';

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function applyDdl(db: PGlite, ddlPath: string): Promise<void> {
  const sql = await readFile(ddlPath, 'utf-8');
  // Same splitter as the production runner, so a statement that only survives
  // because of how it is split cannot pass here and fail at boot.
  for (const statement of splitMigrationStatements(sql)) {
    await db.query(statement);
  }
}

async function main(): Promise<void> {
  const mode = readArg('mode');
  const out = readArg('out');
  if (mode !== 'migrations' && mode !== 'ddl') {
    throw new Error('--mode must be "migrations" or "ddl"');
  }
  if (out === undefined) {
    throw new Error('--out=<dir> is required');
  }

  const db = await createEnginePglite();
  try {
    if (mode === 'migrations') {
      await migrate(db);
    } else {
      const ddl = readArg('ddl');
      if (ddl === undefined) {
        throw new Error('--mode=ddl requires --ddl=<file.sql>');
      }
      await applyDdl(db, ddl);
    }

    await mkdir(out, { recursive: true });
    await writeFile(join(out, `${mode}.schema.txt`), await dumpSchema(db));
    await writeFile(join(out, `${mode}.rowcounts.txt`), await dumpRowCounts(db));
    await writeFile(join(out, `${mode}.data.txt`), await dumpSeedData(db));
    process.stdout.write(`wrote ${mode} dumps to ${out}\n`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
