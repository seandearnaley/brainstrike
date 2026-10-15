#!/usr/bin/env tsx
/**
 * Generates the single current-schema DDL **from a booted database**.
 *
 * The DDL is read back out of the engine's own catalogs after the production
 * bootstrap has run, never transcribed from source. That is the whole point:
 * Postgres normalizes as it applies DDL, so only catalog readback reproduces
 * what was actually built rather than what the SQL meant to build.
 *
 * Production now applies this DDL itself, so a regeneration is a ROUND TRIP:
 * apply the emitted DDL, read the catalogs back, re-emit. A correct DDL is a
 * fixed point of that round trip, which is what makes regeneration safe to run
 * at any time and makes a non-canonical hand edit visible as a diff.
 *
 * The emitted module is TypeScript, not .sql, because it is on the browser boot
 * path: `packages/db` compiles with plain `tsc` and ships `dist/`, so a `.sql`
 * file is never emitted and could not be read without `node:fs`.
 *
 * Emission order is dependency-safe:
 *   extensions -> owned sequences -> tables -> sequence ownership ->
 *   primary/unique/check constraints -> foreign keys -> indexes -> seed rows
 *
 * Usage: tsx scripts/generate-current-schema-ddl.ts --out=<file.ts>
 */

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrations/bootstrap.js';
import { createEnginePglite } from '../src/pglite-factory.js';
import {
  installTimeDefaultColumns,
  MIGRATION_LEDGER_TABLES,
} from '../src/schema-snapshot/introspect.js';

/** Extensions the engine creates implicitly; never emitted. */
const IMPLICIT_EXTENSIONS: readonly string[] = ['plpgsql'];

/**
 * `vector` must precede any table carrying a vector column, and
 * `pg_textsearch` must precede the bm25 index definitions. Anything else keeps
 * catalog order after these.
 */
const EXTENSION_PRIORITY: readonly string[] = ['vector', 'pg_trgm', 'pg_textsearch'];

const NOT_EXTENSION_OWNED = (classid: string, oidExpr: string) => `
  NOT EXISTS (
    SELECT 1 FROM pg_depend dep
    WHERE dep.classid = '${classid}'::regclass AND dep.objid = ${oidExpr} AND dep.deptype = 'e'
  )`;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface ColumnRow {
  attname: string;
  collation: string | null;
  coltype: string;
  def: string | null;
  generated: string;
  identity: string;
  notnull: boolean;
}

async function emitExtensions(db: PGlite): Promise<string[]> {
  const result = await db.query<{ extname: string }>(
    'SELECT extname FROM pg_extension ORDER BY extname'
  );
  const names = result.rows
    .map((row) => row.extname)
    .filter((name) => !IMPLICIT_EXTENSIONS.includes(name));
  const ranked = [...names].sort((left, right) => {
    const leftRank = EXTENSION_PRIORITY.indexOf(left);
    const rightRank = EXTENSION_PRIORITY.indexOf(right);
    if (leftRank !== rightRank) {
      return (
        (leftRank === -1 ? EXTENSION_PRIORITY.length : leftRank) -
        (rightRank === -1 ? EXTENSION_PRIORITY.length : rightRank)
      );
    }
    return left.localeCompare(right);
  });
  return ranked.map((name) => `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(name)};`);
}

/** Public tables, excluding the runner's own ledgers (the runner owns those). */
async function listTables(db: PGlite): Promise<string[]> {
  const result = await db.query<{ relname: string }>(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND ${NOT_EXTENSION_OWNED('pg_class', 'c.oid')}
    ORDER BY c.relname
  `);
  return result.rows
    .map((row) => row.relname)
    .filter((name) => !MIGRATION_LEDGER_TABLES.includes(name));
}

/**
 * Sequences a table column defaults from via `nextval` (serial style). Identity
 * columns are NOT here: Postgres creates their sequence implicitly from the
 * `GENERATED ... AS IDENTITY` clause, and emitting one explicitly would produce
 * a second, unowned sequence.
 */
async function emitOwnedSequences(
  db: PGlite,
  tables: readonly string[]
): Promise<{ create: string[]; own: string[] }> {
  const result = await db.query<{
    seqname: string;
    data_type: string;
    start_value: string;
    increment: string;
    min_value: string;
    max_value: string;
    cycle: boolean;
    tablename: string | null;
    colname: string | null;
  }>(`
    SELECT c.relname AS seqname, format_type(s.seqtypid, NULL) AS data_type,
           s.seqstart::text AS start_value, s.seqincrement::text AS increment,
           s.seqmin::text AS min_value, s.seqmax::text AS max_value, s.seqcycle AS cycle,
           dc.relname AS tablename, da.attname AS colname
    FROM pg_sequence s
    JOIN pg_class c ON c.oid = s.seqrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_depend d
      ON d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype = 'a'
    LEFT JOIN pg_class dc ON dc.oid = d.refobjid
    LEFT JOIN pg_attribute da ON da.attrelid = d.refobjid AND da.attnum = d.refobjsubid
    WHERE n.nspname = 'public' AND ${NOT_EXTENSION_OWNED('pg_class', 'c.oid')}
    ORDER BY c.relname
  `);

  const create: string[] = [];
  const own: string[] = [];
  for (const row of result.rows) {
    if (row.tablename === null || row.colname === null || !tables.includes(row.tablename)) {
      continue;
    }
    // Identity sequences are implicit; detect them by the owning column.
    const identity = await db.query<{ attidentity: string }>(
      `SELECT a.attidentity FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relname = $1 AND a.attname = $2`,
      [row.tablename, row.colname]
    );
    if ((identity.rows[0]?.attidentity ?? '') !== '') {
      continue;
    }
    create.push(
      `CREATE SEQUENCE ${quoteIdent(row.seqname)} AS ${row.data_type} START WITH ${row.start_value} INCREMENT BY ${row.increment} MINVALUE ${row.min_value} MAXVALUE ${row.max_value} ${row.cycle ? 'CYCLE' : 'NO CYCLE'};`
    );
    own.push(
      `ALTER SEQUENCE ${quoteIdent(row.seqname)} OWNED BY ${quoteIdent(row.tablename)}.${quoteIdent(row.colname)};`
    );
  }
  return { create, own };
}

function renderColumn(column: ColumnRow): string {
  const parts = [`  ${quoteIdent(column.attname)} ${column.coltype}`];

  // A non-default collation is part of the column's identity; the implicit
  // "default" collation must not be spelled out or it changes the catalog row.
  if (column.collation !== null && column.collation !== 'default') {
    parts.push(`COLLATE ${quoteIdent(column.collation)}`);
  }

  if (column.generated === 's') {
    // For a generated column pg_attrdef holds the GENERATION expression, not a
    // default. Emitting it as DEFAULT would produce an ordinary column.
    parts.push(`GENERATED ALWAYS AS (${column.def ?? ''}) STORED`);
  } else if (column.identity !== '') {
    parts.push(`GENERATED ${column.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`);
  } else if (column.def !== null) {
    parts.push(`DEFAULT ${column.def}`);
  }

  if (column.notnull) {
    // Inline, so Postgres derives the same auto-generated
    // "<table>_<column>_not_null" constraint name the chain produced.
    parts.push('NOT NULL');
  }
  return parts.join(' ');
}

async function emitTables(db: PGlite, tables: readonly string[]): Promise<string[]> {
  const statements: string[] = [];
  for (const table of tables) {
    const result = await db.query<ColumnRow>(
      `SELECT a.attname,
              format_type(a.atttypid, a.atttypmod) AS coltype,
              a.attnotnull AS notnull,
              pg_get_expr(ad.adbin, ad.adrelid) AS def,
              a.attidentity AS identity,
              a.attgenerated AS generated,
              col.collname AS collation
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
       LEFT JOIN pg_collation col ON col.oid = a.attcollation
       WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [table]
    );
    statements.push(
      `CREATE TABLE ${quoteIdent(table)} (\n${result.rows.map(renderColumn).join(',\n')}\n);`
    );
  }
  return statements;
}

/**
 * Constraints by kind. `n` (not-null) is omitted: it is emitted inline with the
 * column so the auto-generated name matches. `p`/`u`/`c` carry explicit names.
 */
async function emitConstraints(
  db: PGlite,
  tables: readonly string[],
  contypes: readonly string[]
): Promise<string[]> {
  const result = await db.query<{ relname: string; conname: string; def: string }>(
    `SELECT c.relname, con.conname, pg_get_constraintdef(con.oid) AS def
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND con.contype = ANY($1)
     ORDER BY c.relname, con.conname`,
    [contypes]
  );
  return result.rows
    .filter((row) => tables.includes(row.relname))
    .map(
      (row) =>
        `ALTER TABLE ${quoteIdent(row.relname)} ADD CONSTRAINT ${quoteIdent(row.conname)} ${row.def};`
    );
}

/** Indexes that do not already back a constraint (those are created by the ALTERs). */
async function emitIndexes(db: PGlite, tables: readonly string[]): Promise<string[]> {
  const result = await db.query<{ tablename: string; def: string }>(`
    SELECT t.relname AS tablename, pg_get_indexdef(x.indexrelid) AS def
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
    WHERE n.nspname = 'public'
      AND ${NOT_EXTENSION_OWNED('pg_class', 'i.oid')}
      AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.oid)
    ORDER BY t.relname, i.relname
  `);
  return result.rows.filter((row) => tables.includes(row.tablename)).map((row) => `${row.def};`);
}

/** Orders seeded tables so a referenced table is always inserted into first. */
async function orderByDependency(db: PGlite, tables: readonly string[]): Promise<string[]> {
  const result = await db.query<{ child: string; parent: string }>(`
    SELECT c.relname AS child, rc.relname AS parent
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_class rc ON rc.oid = con.confrelid
    WHERE con.contype = 'f'
  `);
  const parents = new Map<string, Set<string>>();
  for (const table of tables) {
    parents.set(table, new Set());
  }
  for (const row of result.rows) {
    if (row.child !== row.parent && parents.has(row.child) && parents.has(row.parent)) {
      parents.get(row.child)?.add(row.parent);
    }
  }

  const ordered: string[] = [];
  const pending = new Set(tables);
  while (pending.size > 0) {
    const ready = [...pending].filter((table) =>
      [...(parents.get(table) ?? [])].every((parent) => ordered.includes(parent))
    );
    if (ready.length === 0) {
      // A cycle among seeded tables would make a single-pass insert order
      // impossible; fail loudly rather than emit DDL that cannot replay.
      throw new Error(`Cyclic foreign keys among seeded tables: ${[...pending].join(', ')}`);
    }
    for (const table of ready.sort()) {
      ordered.push(table);
      pending.delete(table);
    }
  }
  return ordered;
}

/**
 * Seed rows the chain inserted (provider/model catalog, default profiles,
 * view-filter presets). Values round-trip through `::text` and are cast back to
 * the column's declared type, which is exact for every type in this schema
 * (jsonb, timestamptz, numeric, boolean, arrays included).
 */
async function emitSeedData(db: PGlite, tables: readonly string[]): Promise<string[]> {
  const statements: string[] = [];
  // Shared with the schema dumper, so what the seed omits and what the
  // equivalence diff masks can never disagree.
  const installTimeDefaults = await installTimeDefaultColumns(db);
  for (const table of await orderByDependency(db, tables)) {
    const columns = await db.query<{
      attname: string;
      coltype: string;
      generated: string;
      def: string | null;
    }>(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS coltype, a.attgenerated AS generated,
              pg_get_expr(ad.adbin, ad.adrelid) AS def
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [table]
    );
    const omit = installTimeDefaults.get(table) ?? new Set<string>();
    const writable = columns.rows.filter(
      (column) =>
        // Generated columns are recomputed on insert and cannot be written to.
        column.generated !== 's' &&
        // Leave install-time defaults to fire, exactly as the chain's own seeds
        // do: migration 027 inserts presets WITHOUT an id so `uuidv7()` runs,
        // and no seed writes a fixed timestamp. Baking the generation-time
        // literals in would stamp every install with one frozen created_at and
        // one shared set of preset ids -- a runtime behaviour change.
        !omit.has(column.attname)
    );
    const selectList = writable
      .map((column) => `${quoteIdent(column.attname)}::text AS ${quoteIdent(column.attname)}`)
      .join(', ');
    const orderBy = writable.map((_column, index) => index + 1).join(', ');
    const rows = await db.query<Record<string, string | null>>(
      `SELECT ${selectList} FROM ${quoteIdent(table)} ORDER BY ${orderBy}`
    );
    if (rows.rows.length === 0) {
      continue;
    }

    const values = rows.rows.map((row) => {
      const literals = writable.map((column) => {
        const value = row[column.attname];
        return value === null ? 'NULL' : `${quoteLiteral(value)}::${column.coltype}`;
      });
      return `  (${literals.join(', ')})`;
    });
    statements.push(
      `INSERT INTO ${quoteIdent(table)} (${writable
        .map((column) => quoteIdent(column.attname))
        .join(', ')}) VALUES\n${values.join(',\n')};`
    );
  }
  return statements;
}

/** Signatures of every function PUBLIC may NOT execute in `db`. */
async function publicRevokedFunctions(db: PGlite): Promise<Set<string>> {
  const result = await db.query<{ signature: string }>(
    `SELECT quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' ||
            pg_get_function_identity_arguments(p.oid) || ')' AS signature
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE NOT has_function_privilege('public', p.oid, 'EXECUTE')`
  );
  return new Set(result.rows.map((row) => row.signature));
}

/**
 * The `REVOKE EXECUTE ... FROM PUBLIC` statements THIS schema is responsible
 * for, derived by diffing the built database against a pristine one.
 *
 * Postgres ships a number of its own functions PUBLIC-revoked (`lo_import`,
 * `pg_backup_start`, ...), so "PUBLIC cannot execute it" alone does not mean
 * the schema revoked it. The baseline is built here, with the SAME extensions,
 * so the difference is exactly what this repository took away and the list
 * re-derives itself if the engine's own defaults ever change. Deliberately not
 * a hand-written list of function names: that is the kind of shortcut this
 * whole file exists to avoid.
 *
 * The chain revoked `pg_sleep`, `pg_sleep_for`, `pg_sleep_until` and
 * `set_config` in migration 074 and migration 151 deliberately kept them; they
 * are verified sandbox escapes, not hardening theatre, and a schema that stops
 * reproducing them silently restores a denial-of-service primitive to every
 * role.
 */
async function emitFunctionPrivileges(
  db: PGlite,
  extensionStatements: readonly string[]
): Promise<string[]> {
  const baseline = await createEnginePglite();
  try {
    for (const statement of extensionStatements) {
      await baseline.query(statement);
    }
    const pristine = await publicRevokedFunctions(baseline);
    const built = await publicRevokedFunctions(db);
    return [...built]
      .filter((signature) => !pristine.has(signature))
      .sort()
      .map((signature) => `REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC;`);
  } finally {
    await baseline.close();
  }
}

function section(title: string, statements: readonly string[]): string {
  if (statements.length === 0) {
    return `-- ${title}: none\n`;
  }
  return `-- ${title} (${statements.length})\n${statements.join('\n')}\n`;
}

/**
 * The DDL is emitted inside a template literal, so a backtick, a `${` or a
 * backslash in the SQL would change what the module evaluates to. No construct
 * in this schema produces one; if one ever does, fail here rather than emit a
 * module whose DDL silently differs from the database it was read from.
 */
function assertTemplateLiteralSafe(ddl: string): void {
  const hazards = ['`', '${', '\\'].filter((hazard) => ddl.includes(hazard));
  if (hazards.length > 0) {
    throw new Error(
      `Current-schema DDL contains template-literal hazards (${hazards.join(' ')}); the emitter must be taught to escape them before this schema can ship.`
    );
  }
}

/**
 * The ledger identity of the schema, derived from the DDL text itself rather
 * than maintained by hand. Any change to the schema therefore changes the
 * ledger key, and `assertNoStaleDrizzleMigrationLedger` rejects a profile built
 * by the previous one instead of leaving it on a schema this build no longer
 * ships. ADR-0020: greenfield databases are reset, not upgraded.
 */
function ledgerKeyFor(ddl: string): string {
  return `custom-current-schema-${createHash('sha256').update(ddl, 'utf-8').digest('hex')}`;
}

function renderModule(ddl: string): string {
  assertTemplateLiteralSafe(ddl);
  return `/**
 * Brainstrike current-schema DDL: the whole schema in one step.
 *
 * GENERATED by packages/db/scripts/generate-current-schema-ddl.ts by reading
 * the catalogs of a database the production bootstrap built. Do not hand-edit:
 * run \`pnpm --filter @brainstrike/db db:schema:ddl\`.
 *
 * This is what production applies at boot (via migrations/001-current-schema.ts).
 * It replaced a 151-step incremental chain whose only remaining job was to
 * construct this schema (ADR-0020: the product is greenfield, so there is no
 * migration history worth replaying). The schema is held to the catalog
 * readback of the database that chain built, frozen in
 * __tests__/fixtures/schema-catalog.snapshot.txt; changing this file without
 * regenerating that snapshot fails
 * __tests__/current-schema-catalog.integration.test.ts.
 */

/** sha256 of {@link CURRENT_SCHEMA_DDL}; the schema's ledger identity. */
// Pre-wrapped: the key is longer than the formatter's line width, so emitting it
// on one line would make a freshly generated file fail \`biome check\` until a
// \`--fix\` pass rewrote it. Regeneration has to be clean on its own.
export const CURRENT_SCHEMA_LEDGER_KEY =
  '${ledgerKeyFor(ddl)}';

export const CURRENT_SCHEMA_DDL = \`${ddl}\`;
`;
}

async function main(): Promise<void> {
  const outPath = process.argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length);
  if (outPath === undefined) {
    throw new Error('--out=<file.ts> is required');
  }

  const db = await createEnginePglite();
  try {
    // Build the reference database with the real production bootstrap, then
    // read the schema back out of it.
    await migrate(db);

    const tables = await listTables(db);
    const sequences = await emitOwnedSequences(db, tables);
    const extensionStatements = await emitExtensions(db);

    const ddl = [
      section('EXTENSIONS', extensionStatements),
      // After EXTENSIONS, because a revoke may target a function an extension
      // created; before everything else, because nothing below depends on it.
      section('FUNCTION PRIVILEGES', await emitFunctionPrivileges(db, extensionStatements)),
      section('SEQUENCES', sequences.create),
      section('TABLES', await emitTables(db, tables)),
      section('SEQUENCE OWNERSHIP', sequences.own),
      section(
        'PRIMARY KEY / UNIQUE / CHECK CONSTRAINTS',
        await emitConstraints(db, tables, ['p', 'u', 'c'])
      ),
      section('FOREIGN KEY CONSTRAINTS', await emitConstraints(db, tables, ['f'])),
      section('INDEXES', await emitIndexes(db, tables)),
      section('SEED DATA', await emitSeedData(db, tables)),
    ].join('\n');

    await writeFile(outPath, renderModule(ddl));
    process.stdout.write(`wrote current-schema DDL to ${outPath}\n`);
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
