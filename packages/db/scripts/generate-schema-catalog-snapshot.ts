#!/usr/bin/env tsx
/**
 * Generates the frozen catalog snapshot of the schema production boots.
 *
 * Boots a COLD, EMPTY cluster through the production bootstrap (`migrate`) and
 * writes back what the engine's own catalogs report: schema, row counts and
 * seed-row content. Catalog readback, never the SQL that produced it, so a
 * default Postgres rewrote or an index parameter that fell back to its own
 * default is visible in the diff.
 *
 * PROVENANCE: the committed snapshot was first generated while production still
 * replayed the 151-migration chain, so its content is the chain's output. The
 * collapse to a single current-schema DDL is held to it by
 * __tests__/current-schema-catalog.integration.test.ts: that test is the
 * standing proof the schema did not move, and it is the reason this file is
 * regenerated only together with a deliberate schema change.
 *
 * Usage: tsx scripts/generate-schema-catalog-snapshot.ts --out=<file.txt>
 */

import { writeFile } from 'node:fs/promises';
import { migrate } from '../src/migrations/bootstrap.js';
import { createEnginePglite } from '../src/pglite-factory.js';
import { dumpRowCounts, dumpSchema, dumpSeedData } from '../src/schema-snapshot/introspect.js';

export async function buildSchemaCatalogSnapshot(): Promise<string> {
  const db = await createEnginePglite();
  try {
    await migrate(db);
    return [await dumpSchema(db), await dumpRowCounts(db), await dumpSeedData(db)].join('\n');
  } finally {
    await db.close();
  }
}

async function main(): Promise<void> {
  const outPath = process.argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length);
  if (outPath === undefined) {
    throw new Error('--out=<file.txt> is required');
  }
  await writeFile(outPath, await buildSchemaCatalogSnapshot());
  process.stdout.write(`wrote schema catalog snapshot to ${outPath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
