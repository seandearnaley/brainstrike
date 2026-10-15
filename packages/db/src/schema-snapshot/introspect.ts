/**
 * Canonical schema introspection for PGlite databases.
 *
 * Reads what the engine ACTUALLY built from its own catalogs, rather than what
 * a migration's source text asked for. Postgres normalizes as it applies DDL
 * (default expressions gain cast annotations, check constraints are reparsed,
 * HNSW index options land in `reloptions`), so catalog readback is the only
 * representation of a schema that two independently-constructed databases can
 * be diffed on.
 *
 * Output is a deterministic, line-oriented text document: every section is
 * sorted by a stable key, so an ordinary textual diff of two dumps is a
 * schema-equivalence verdict.
 */

import type { PGlite } from '@electric-sql/pglite';

export type IntrospectableDb = Pick<PGlite, 'query'>;

/**
 * Migration ledgers record WHICH migrations ran, which is exactly what a
 * collapse changes on purpose. Their table definitions are compared like any
 * other table; only their rows are excluded from the data section.
 */
export const MIGRATION_LEDGER_TABLES: readonly string[] = ['__drizzle_migrations', '_migrations'];

/**
 * Objects a loaded extension owns are identical whenever the extension set and
 * versions are identical, and there are thousands of them (pgvector,
 * pg_textsearch and pg_trgm each install a large function surface). The
 * extension section pins name and version instead; per-object sections exclude
 * them so the dump describes only what this repository's DDL creates.
 */
const NOT_EXTENSION_OWNED = (classid: string, oidExpr: string) => `
  NOT EXISTS (
    SELECT 1 FROM pg_depend dep
    WHERE dep.classid = '${classid}'::regclass
      AND dep.objid = ${oidExpr}
      AND dep.deptype = 'e'
  )`;

interface Section {
  readonly lines: readonly string[];
  readonly title: string;
}

function renderSections(sections: readonly Section[]): string {
  const body = sections
    .map((section) => {
      const lines = [...section.lines].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0
      );
      const rendered = lines.length > 0 ? lines.join('\n') : '(none)';
      return `-- ======== ${section.title} (${lines.length}) ========\n${rendered}`;
    })
    .join('\n\n');
  return `${body}\n`;
}

async function extensions(db: IntrospectableDb): Promise<readonly string[]> {
  const result = await db.query<{ extname: string; extversion: string; nspname: string }>(`
    SELECT e.extname, e.extversion, n.nspname
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
  `);
  return result.rows.map(
    (row) => `extension ${row.extname} version=${row.extversion} schema=${row.nspname}`
  );
}

async function enumTypes(db: IntrospectableDb): Promise<readonly string[]> {
  const result = await db.query<{ typname: string; labels: string }>(`
    SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname = 'public' AND ${NOT_EXTENSION_OWNED('pg_type', 't.oid')}
    GROUP BY t.typname
  `);
  return result.rows.map((row) => `enum ${row.typname} = (${row.labels})`);
}

async function domainTypes(db: IntrospectableDb): Promise<readonly string[]> {
  const result = await db.query<{
    typname: string;
    base: string;
    notnull: boolean;
    def: string | null;
    constraints: string | null;
  }>(`
    SELECT
      t.typname,
      format_type(t.typbasetype, t.typtypmod) AS base,
      t.typnotnull AS notnull,
      t.typdefault AS def,
      (
        SELECT string_agg(pg_get_constraintdef(c.oid), ' | ' ORDER BY c.conname)
        FROM pg_constraint c WHERE c.contypid = t.oid
      ) AS constraints
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'd' AND ${NOT_EXTENSION_OWNED('pg_type', 't.oid')}
  `);
  return result.rows.map(
    (row) =>
      `domain ${row.typname} base=${row.base} notnull=${row.notnull} default=${row.def ?? 'NULL'} checks=${row.constraints ?? '-'}`
  );
}

async function relations(db: IntrospectableDb): Promise<readonly string[]> {
  const result = await db.query<{
    relname: string;
    relkind: string;
    persistence: string;
    rowsecurity: boolean;
    reloptions: string | null;
  }>(`
    SELECT c.relname, c.relkind, c.relpersistence AS persistence, c.relrowsecurity AS rowsecurity,
           array_to_string(c.reloptions, ',') AS reloptions
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND ${NOT_EXTENSION_OWNED('pg_class', 'c.oid')}
  `);
  return result.rows.map(
    (row) =>
      `relation ${row.relname} kind=${row.relkind} persistence=${row.persistence} rls=${row.rowsecurity} reloptions=${row.reloptions ?? '-'}`
  );
}

async function columns(db: IntrospectableDb): Promise<readonly string[]> {
  const result = await db.query<{
    relname: string;
    attname: string;
    attnum: number;
    coltype: string;
    notnull: boolean;
    def: string | null;
    identity: string;
    generated: string;
    collation: string | null;
    storage: string;
  }>(`
    SELECT
      c.relname,
      a.attname,
      a.attnum,
      format_type(a.atttypid, a.atttypmod) AS coltype,
      a.attnotnull AS notnull,
      pg_get_expr(ad.adbin, ad.adrelid) AS def,
      a.attidentity AS identity,
      a.attgenerated AS generated,
      col.collname AS collation,
      a.attstorage AS storage
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    LEFT JOIN pg_collation col ON col.oid = a.attcollation
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND ${NOT_EXTENSION_OWNED('pg_class', 'c.oid')}
  `);
  // Rank LIVE columns densely per table rather than printing raw `attnum`.
  //
  // `attnum` is an attribute slot, and `ALTER TABLE ... DROP COLUMN` retires a
  // slot without reusing it, so a schema built by a chain that dropped columns
  // carries holes a freshly-created one does not. No SQL can observe a hole.
  // What IS observable is the ORDER of the live columns -- `SELECT *` output
  // order and `INSERT` without a column list -- and a dense rank preserves
  // that exactly while ignoring the physical gap.
  const byTable = new Map<string, typeof result.rows>();
  for (const row of result.rows) {
    const existing = byTable.get(row.relname);
    if (existing === undefined) {
      byTable.set(row.relname, [row]);
    } else {
      existing.push(row);
    }
  }

  const lines: string[] = [];
  for (const rows of byTable.values()) {
    const ordered = [...rows].sort((left, right) => left.attnum - right.attnum);
    for (const [index, row] of ordered.entries()) {
      lines.push(
        `column ${row.relname}.${String(index + 1).padStart(4, '0')}.${row.attname} type=${row.coltype} notnull=${row.notnull} default=${row.def ?? 'NULL'} identity=${row.identity || '-'} generated=${row.generated || '-'} collation=${row.collation ?? '-'} storage=${row.storage}`
      );
    }
  }
  return lines;
}

async function constraints(db: IntrospectableDb): Promise<readonly string[]> {
  const result = await db.query<{
    relname: string;
    conname: string;
    contype: string;
    def: string;
    deferrable: boolean;
    deferred: boolean;
    validated: boolean;
  }>(`
    SELECT c.relname, con.conname, con.contype, pg_get_constraintdef(con.oid) AS def,
           con.condeferrable AS deferrable, con.condeferred AS deferred, con.convalidated AS validated
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND ${NOT_EXTENSION_OWNED('pg_class', 'c.oid')}
  `);
  return result.rows.map(
    (row) =>
      `constraint ${row.relname}.${row.conname} type=${row.contype} deferrable=${row.deferrable} deferred=${row.deferred} validated=${row.validated} :: ${row.def}`
  );
}

async function indexes(db: IntrospectableDb): Promise<readonly string[]> {
  const result = await db.query<{
    tablename: string;
    indexname: string;
    def: string;
    reloptions: string | null;
    amname: string;
    isvalid: boolean;
    isready: boolean;
  }>(`
    SELECT t.relname AS tablename, i.relname AS indexname, pg_get_indexdef(x.indexrelid) AS def,
           array_to_string(i.reloptions, ',') AS reloptions, am.amname,
           x.indisvalid AS isvalid, x.indisready AS isready
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname = 'public' AND ${NOT_EXTENSION_OWNED('pg_class', 'i.oid')}
  `);
  return result.rows.map(
    (row) =>
      // `pg_get_indexdef` already renders WITH (m=..., ef_construction=...) for
      // HNSW; reloptions and amname are repeated so a lost parameter or a
      // silently different access method is visible on its own.
      `index ${row.tablename}.${row.indexname} am=${row.amname} valid=${row.isvalid} ready=${row.isready} reloptions=${row.reloptions ?? '-'} :: ${row.def}`
  );
}

async function sequences(db: IntrospectableDb): Promise<readonly string[]> {
  const result = await db.query<{
    seqname: string;
    data_type: string;
    start_value: string;
    increment: string;
    min_value: string;
    max_value: string;
    cycle: boolean;
    owned_by: string | null;
  }>(`
    SELECT c.relname AS seqname, format_type(s.seqtypid, NULL) AS data_type,
           s.seqstart::text AS start_value, s.seqincrement::text AS increment,
           s.seqmin::text AS min_value, s.seqmax::text AS max_value, s.seqcycle AS cycle,
           (
             SELECT dc.relname || '.' || da.attname
             FROM pg_depend d
             JOIN pg_class dc ON dc.oid = d.refobjid
             JOIN pg_attribute da ON da.attrelid = d.refobjid AND da.attnum = d.refobjsubid
             WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
             LIMIT 1
           ) AS owned_by
    FROM pg_sequence s
    JOIN pg_class c ON c.oid = s.seqrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND ${NOT_EXTENSION_OWNED('pg_class', 'c.oid')}
  `);
  return result.rows.map(
    (row) =>
      // Deliberately NOT last_value: that is runtime state, not schema.
      `sequence ${row.seqname} type=${row.data_type} start=${row.start_value} increment=${row.increment} min=${row.min_value} max=${row.max_value} cycle=${row.cycle} ownedby=${row.owned_by ?? '-'}`
  );
}

async function viewDefinitions(db: IntrospectableDb): Promise<readonly string[]> {
  const result = await db.query<{ relname: string; relkind: string; def: string }>(`
    SELECT c.relname, c.relkind, pg_get_viewdef(c.oid, true) AS def
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') AND ${NOT_EXTENSION_OWNED('pg_class', 'c.oid')}
  `);
  return result.rows.map(
    (row) => `view ${row.relname} kind=${row.relkind} :: ${row.def.replace(/\s+/g, ' ').trim()}`
  );
}

async function triggers(db: IntrospectableDb): Promise<readonly string[]> {
  const result = await db.query<{ relname: string; tgname: string; def: string; enabled: string }>(`
    SELECT c.relname, tg.tgname, pg_get_triggerdef(tg.oid) AS def, tg.tgenabled AS enabled
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND NOT tg.tgisinternal
      AND ${NOT_EXTENSION_OWNED('pg_class', 'c.oid')}
  `);
  return result.rows.map(
    (row) => `trigger ${row.relname}.${row.tgname} enabled=${row.enabled} :: ${row.def}`
  );
}

async function routines(db: IntrospectableDb): Promise<readonly string[]> {
  const result = await db.query<{ proname: string; args: string; def: string; kind: string }>(`
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_functiondef(p.oid) AS def, p.prokind AS kind
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind IN ('f', 'p', 'w')
      AND ${NOT_EXTENSION_OWNED('pg_proc', 'p.oid')}
  `);
  return result.rows.map(
    (row) =>
      `routine ${row.proname}(${row.args}) kind=${row.kind} :: ${row.def.replace(/\s+/g, ' ').trim()}`
  );
}

async function comments(db: IntrospectableDb): Promise<readonly string[]> {
  const result = await db.query<{ target: string; comment: string }>(`
    SELECT c.relname || COALESCE('.' || a.attname, '') AS target, d.description AS comment
    FROM pg_description d
    JOIN pg_class c ON c.oid = d.objoid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid AND d.objsubid > 0
    WHERE n.nspname = 'public'
      AND d.classoid = 'pg_class'::regclass
      AND ${NOT_EXTENSION_OWNED('pg_class', 'c.oid')}
  `);
  return result.rows.map((row) => `comment ${row.target} :: ${row.comment.replace(/\s+/g, ' ')}`);
}

/**
 * Lists the tables whose rows take part in data equivalence: every ordinary
 * public table except the migration ledgers.
 */
async function dataTables(db: IntrospectableDb): Promise<readonly string[]> {
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
 * Row counts for every data table. A schema can be identical while the seed
 * data a migration chain inserted (the provider/model catalog, default
 * embedding profiles) is missing, so counts are part of the verdict.
 */
export async function dumpRowCounts(db: IntrospectableDb): Promise<string> {
  const tables = await dataTables(db);
  const lines: string[] = [];
  for (const table of tables) {
    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "${table}"`
    );
    lines.push(`rows ${table} = ${result.rows[0]?.count ?? '0'}`);
  }
  return renderSections([{ lines, title: 'ROW COUNTS' }]);
}

/**
 * SQL constructs that read the clock or the session without looking like a
 * function call. `pg_get_expr` prints these as bare keywords, so no function
 * name can be extracted from them.
 */
const BARE_NONDETERMINISTIC_SQL =
  /\b(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|LOCALTIMESTAMP|LOCALTIME|CURRENT_USER|SESSION_USER|CURRENT_ROLE)\b/i;

/** Function-call names in a canonical `pg_get_expr` rendering. */
function referencedFunctionNames(expression: string): string[] {
  return [...expression.matchAll(/([a-z_][a-z0-9_]*)\s*\(/gi)].map((match) =>
    (match[1] ?? '').toLowerCase()
  );
}

/**
 * Columns whose DEFAULT produces a different value on every install: the clock
 * (`now()`, `CURRENT_TIMESTAMP`) and generated identities (`uuidv7()`,
 * `gen_random_uuid()`).
 *
 * Volatility is read from `pg_proc` rather than matched against a hand-written
 * list, so a default added later is classified by what Postgres says about it.
 * (A dependency-based lookup would be neater but returns nothing: Postgres
 * pins built-in functions and records no `pg_depend` row for them.)
 *
 * These are the only values two independently-constructed databases may differ
 * on, because the seed rows deliberately leave them to the default.
 */
export async function installTimeDefaultColumns(
  db: IntrospectableDb
): Promise<Map<string, Set<string>>> {
  const result = await db.query<{ relname: string; attname: string; def: string | null }>(`
    SELECT c.relname, a.attname, pg_get_expr(ad.adbin, ad.adrelid) AS def
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
  `);

  const names = new Set<string>();
  for (const row of result.rows) {
    for (const name of referencedFunctionNames(row.def ?? '')) {
      names.add(name);
    }
  }

  const volatility = await db.query<{ proname: string; nondeterministic: boolean }>(
    `SELECT proname, bool_or(provolatile <> 'i') AS nondeterministic
     FROM pg_proc WHERE proname = ANY($1) GROUP BY proname`,
    [[...names]]
  );
  const nondeterministicFunctions = new Set(
    volatility.rows.filter((row) => row.nondeterministic).map((row) => row.proname)
  );

  const byTable = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const expression = row.def ?? '';
    const nondeterministic =
      BARE_NONDETERMINISTIC_SQL.test(expression) ||
      referencedFunctionNames(expression).some((name) => nondeterministicFunctions.has(name));
    if (!nondeterministic) {
      continue;
    }
    const existing = byTable.get(row.relname);
    if (existing === undefined) {
      byTable.set(row.relname, new Set([row.attname]));
    } else {
      existing.add(row.attname);
    }
  }
  return byTable;
}

/**
 * Full row content for every non-empty data table, canonicalized to sorted
 * JSON text. This is what proves the seeded catalog survived the collapse.
 *
 * Values in install-time-defaulted columns are replaced by a marker: every seed
 * in the chain leaves those to the DEFAULT (or writes `NOW()` itself), so their
 * content is particular to the database that was built -- its construction
 * time, its generated preset ids. The marker still proves null-vs-set, and
 * which columns are masked is itself derived from the schema the diff proves
 * equal, so a column cannot be hidden by changing its default.
 */
export async function dumpSeedData(db: IntrospectableDb): Promise<string> {
  const tables = await dataTables(db);
  const masked = await installTimeDefaultColumns(db);
  const sections: Section[] = [];
  for (const table of tables) {
    const result = await db.query<Record<string, unknown>>(`SELECT * FROM "${table}"`);
    if (result.rows.length === 0) {
      continue;
    }
    const maskedHere = masked.get(table) ?? new Set<string>();
    sections.push({
      lines: result.rows.map((row) => {
        const canonical = Object.keys(row)
          .sort()
          .map((key) => {
            const value = row[key];
            if (maskedHere.has(key) && value !== null) {
              return [key, '<install-time-default>'] as const;
            }
            return [key, value] as const;
          });
        return `${table} :: ${JSON.stringify(canonical, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        )}`;
      }),
      title: `DATA ${table}`,
    });
  }

  const maskNote = [...masked.entries()]
    .filter(([table]) => tables.includes(table))
    .flatMap(([table, cols]) => [...cols].map((col) => `masked ${table}.${col}`));

  return renderSections([
    { lines: maskNote, title: 'INSTALL-TIME DEFAULT COLUMNS (values masked)' },
    ...sections,
  ]);
}

/**
 * Functions PUBLIC may NOT execute, and relations PUBLIC holds any privilege on.
 *
 * ACLs are compared as EFFECTIVE PRIVILEGE, never as raw `proacl`/`relacl` text.
 * Raw text would be both too strict and too weak: a `GRANT` that is later
 * revoked leaves `relacl` materialized as `{owner=arwdDxtm/owner}`, which is
 * semantically identical to the `NULL` a never-granted table keeps, so a text
 * comparison reports a difference where no privilege differs. What matters --
 * and what a schema dump otherwise cannot see at all -- is who can actually do
 * what.
 *
 * This section exists because it was MISSING: the pre-collapse equivalence
 * proof compared relations, columns, constraints, indexes and rows, reported a
 * zero diff, and could not have seen that the chain's
 * `REVOKE EXECUTE ON FUNCTION pg_sleep(...) FROM PUBLIC` (migration 074, which
 * migration 151 deliberately preserved) had stopped being reproduced. `pg_sleep`
 * is a denial-of-service primitive and `set_config` reaches session GUCs; both
 * were revoked as verified sandbox escapes. A clean diff over the wrong set
 * proves nothing.
 *
 * Engine built-ins that Postgres itself ships PUBLIC-revoked (`lo_import`,
 * `pg_backup_start`, ...) appear here too, and that is correct: both sides of
 * any comparison start from the same initdb, so they cancel, and a future
 * engine bump that changed them would be worth seeing.
 */
async function functionPrivileges(db: IntrospectableDb): Promise<string[]> {
  const result = await db.query<{ signature: string }>(
    `SELECT quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' ||
            pg_get_function_identity_arguments(p.oid) || ')' AS signature
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE NOT has_function_privilege('public', p.oid, 'EXECUTE')
     ORDER BY 1`
  );
  return result.rows.map((row) => `no-public-execute ${row.signature}`);
}

/**
 * Any privilege PUBLIC holds on a relation. Expected to be empty: nothing in
 * this schema grants to PUBLIC, and a row appearing here is a table the world
 * can touch.
 */
async function relationPublicPrivileges(db: IntrospectableDb): Promise<string[]> {
  const result = await db.query<{ relname: string; privilege: string }>(
    `SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS relname, priv AS privilege
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS priv
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
       AND has_table_privilege('public', c.oid, priv)
     ORDER BY 1, 2`
  );
  return result.rows.map((row) => `public-can ${row.privilege} ${row.relname}`);
}

/** The canonical schema document for a database. */
export async function dumpSchema(db: IntrospectableDb): Promise<string> {
  // Sequential: PGlite is a single connection, so concurrent reads only queue
  // behind each other. Twelve catalog queries cost nothing; clarity wins.
  const sections: Section[] = [
    { lines: await extensions(db), title: 'EXTENSIONS' },
    { lines: await enumTypes(db), title: 'ENUM TYPES' },
    { lines: await domainTypes(db), title: 'DOMAIN TYPES' },
    { lines: await relations(db), title: 'RELATIONS' },
    { lines: await columns(db), title: 'COLUMNS' },
    { lines: await constraints(db), title: 'CONSTRAINTS' },
    { lines: await indexes(db), title: 'INDEXES' },
    { lines: await sequences(db), title: 'SEQUENCES' },
    { lines: await viewDefinitions(db), title: 'VIEWS' },
    { lines: await triggers(db), title: 'TRIGGERS' },
    { lines: await routines(db), title: 'ROUTINES' },
    { lines: await comments(db), title: 'COMMENTS' },
    { lines: await functionPrivileges(db), title: 'FUNCTION PRIVILEGES' },
    { lines: await relationPublicPrivileges(db), title: 'RELATION PUBLIC PRIVILEGES' },
  ];

  return renderSections(sections);
}
