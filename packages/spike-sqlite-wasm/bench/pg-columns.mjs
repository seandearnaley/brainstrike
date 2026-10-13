// BST-1940 spike: production PGlite schema facts the web workload needs (columns, indexes, triggers).
// Runs the production migrations in Node PGlite with the production extension set.
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { migrate } from '../../db/dist/migrations/bootstrap.js';

// biome-ignore lint/style/useNamingConvention: PGlite extension keys are the Postgres extension names.
const db = await PGlite.create({ extensions: { pg_textsearch, pg_trgm, vector } });
await migrate(db);
const out = {};
for (const table of ['file_records', 'file_chunks', 'embedding_sets']) {
  out[table] = {
    columns: (
      await db.query(
        `SELECT column_name, data_type, is_nullable, column_default, is_generated, generation_expression
         FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`,
        [table]
      )
    ).rows,
    indexes: (
      await db.query('SELECT indexname, indexdef FROM pg_indexes WHERE tablename=$1', [table])
    ).rows,
    triggers: (
      await db.query(
        'SELECT tgname FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal',
        [table]
      )
    ).rows,
  };
}
out.tables = (
  await db.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")
).rows[0];
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
await db.close();
