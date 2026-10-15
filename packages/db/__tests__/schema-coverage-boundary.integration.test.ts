import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { TEST_ENGINE_EXTENSIONS } from './helpers/migrated-test-db.js';

/**
 * Makes the schema comparison's COVERAGE BOUNDARY explicit and enforced.
 *
 * `current-schema-catalog.integration.test.ts` compares the shipped schema to a
 * frozen catalog readback. That comparison is only as good as the catalog
 * classes it reads, and twice now this PR shipped a defect in a class it did
 * not read: the collapse silently restored `PUBLIC EXECUTE` on `pg_sleep` and
 * `set_config` while the dump reported a zero diff, because it compared no
 * ACLs at all. The generalizable defect was not the missing columns -- it was
 * that "no diff" silently meant "no diff in what I happened to look at".
 *
 * So this file states the other half out loud. For every catalog class the dump
 * does NOT compare, it asserts the shipped schema adds NOTHING there, measured
 * against a pristine database carrying the same extensions. The moment someone
 * adds an RLS policy, a default ACL, an event trigger or a custom type, this
 * fails and they must either extend the dump to compare it properly or say why
 * it does not need comparing. The boundary becomes enforced instead of assumed.
 *
 * Identity-with-pristine rather than literal emptiness, deliberately: `pg_cast`
 * ships 258 rows and `pg_operator` 855, so "empty" is the wrong assertion for
 * most of these. Identity subsumes emptiness for the classes that are empty
 * (RLS policies, event triggers, default ACLs) and still catches an addition in
 * the ones that are not.
 *
 * COMPARED by the catalog fixture, not here: extensions, enum and domain types,
 * relations, columns, constraints, indexes, sequences, views, triggers,
 * routines, comments, function privileges, relation PUBLIC privileges, row
 * counts and seed rows.
 */

/** Catalog classes the schema dump does not compare, keyed by a stable identity. */
const UNCOMPARED_CLASSES: Readonly<Record<string, string>> = {
  'access methods': 'SELECT amname AS k FROM pg_am',
  casts: `SELECT castsource::regtype::text || '->' || casttarget::regtype::text AS k FROM pg_cast`,
  collations: 'SELECT collname AS k FROM pg_collation',
  // 074 used ALTER DEFAULT PRIVILEGES; 151 removed it. Empty on both sides.
  'default privileges': `SELECT defaclnamespace::regnamespace::text || ':' || defaclobjtype::text ||
       ':' || COALESCE(defaclacl::text, '') AS k FROM pg_default_acl`,
  'event triggers': 'SELECT evtname AS k FROM pg_event_trigger',
  'extended statistics': 'SELECT stxname AS k FROM pg_statistic_ext',
  'foreign servers': 'SELECT srvname AS k FROM pg_foreign_server',
  'operator classes': `SELECT o.opcname || ':' || a.amname AS k
     FROM pg_opclass o JOIN pg_am a ON a.oid = o.opcmethod`,
  operators: `SELECT oprname || '(' || oprleft::regtype::text || ',' ||
       oprright::regtype::text || ')' AS k FROM pg_operator`,
  publications: 'SELECT pubname AS k FROM pg_publication',
  'rls policies': `SELECT polrelid::regclass::text || '.' || polname AS k FROM pg_policy`,
  'role settings': `SELECT setdatabase::text || ':' || setrole::text || ':' ||
       COALESCE(setconfig::text, '') AS k FROM pg_db_role_setting`,
  // 074 created `brainstrike_agent_readonly`; 151 dropped it. Identical means
  // the shipped schema leaves no role behind.
  roles: 'SELECT rolname AS k FROM pg_roles',
  rules: `SELECT ev_class::regclass::text || '.' || rulename AS k
     FROM pg_rewrite WHERE rulename <> '_RETURN'`,
  'schema PUBLIC access': `SELECT nspname AS k FROM pg_namespace
     WHERE has_schema_privilege('public', oid, 'USAGE')
        OR has_schema_privilege('public', oid, 'CREATE')`,
  schemas: 'SELECT nspname AS k FROM pg_namespace',
  'security labels': `SELECT objoid::text || ':' || label AS k FROM pg_seclabel`,
  // Standalone composite/range/multirange types only: the implicit row type
  // every table carries shadows RELATIONS, which the fixture does compare.
  'standalone types': `SELECT n.nspname || '.' || t.typname AS k
     FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     LEFT JOIN pg_class c ON c.oid = t.typrelid
     WHERE t.typtype IN ('c', 'r', 'm')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND (t.typrelid = 0 OR c.relkind = 'c')`,
  subscriptions: 'SELECT subname AS k FROM pg_subscription',
  'table inheritance': `SELECT inhrelid::regclass::text || '<' || inhparent::regclass::text AS k
     FROM pg_inherits`,
  tablespaces: 'SELECT spcname AS k FROM pg_tablespace',
  'text search configs': 'SELECT cfgname AS k FROM pg_ts_config',
  'text search dictionaries': 'SELECT dictname AS k FROM pg_ts_dict',
};

async function identities(db: PGlite, sql: string): Promise<Set<string>> {
  const result = await db.query<{ k: string }>(sql);
  return new Set(result.rows.map((row) => String(row.k)));
}

/** The extension set the shipped schema installs, read from the built database. */
async function installedExtensions(db: PGlite): Promise<string[]> {
  const result = await db.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname`
  );
  return result.rows.map((row) => row.extname);
}

describe('schema coverage boundary', () => {
  it('adds nothing in any catalog class the comparison does not read', async () => {
    const shipped = new PGlite({ extensions: TEST_ENGINE_EXTENSIONS });
    const pristine = new PGlite({ extensions: TEST_ENGINE_EXTENSIONS });
    try {
      await migrate(shipped);
      // The baseline carries the same extensions, so an object an extension
      // installs is not mistaken for one this schema added.
      for (const extension of await installedExtensions(shipped)) {
        await pristine.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
      }

      const drift: string[] = [];
      for (const [name, sql] of Object.entries(UNCOMPARED_CLASSES)) {
        const [before, after] = [await identities(pristine, sql), await identities(shipped, sql)];
        const added = [...after].filter((key) => !before.has(key)).sort();
        const removed = [...before].filter((key) => !after.has(key)).sort();
        if (added.length > 0 || removed.length > 0) {
          drift.push(`${name}: added [${added.join(', ')}] removed [${removed.join(', ')}]`);
        }
      }

      expect(
        drift,
        'The shipped schema touched a catalog class the comparison does not read. ' +
          'Either extend the dump in src/schema-snapshot/introspect.ts to compare it ' +
          'properly and regenerate the fixture, or record here why it needs no comparison.'
      ).toEqual([]);
    } finally {
      await shipped.close();
      await pristine.close();
    }
  }, 180_000);

  it('covers every class the boundary claims to cover', () => {
    // Guards the guard: an empty or silently-shrunk map would pass the
    // assertion above while checking nothing.
    expect(Object.keys(UNCOMPARED_CLASSES).length).toBeGreaterThanOrEqual(23);
    for (const [name, sql] of Object.entries(UNCOMPARED_CLASSES)) {
      expect(sql, `${name} must select a column aliased k`).toMatch(/\bAS k\b/u);
    }
  });
});
