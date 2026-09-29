/**
 * The BST-1876 exhaustiveness guard: on a fully migrated database every public
 * table is classified exactly once in the durability registry, every entry names
 * a real table, and every `derived` entry's rebuild owner resolves to an exported
 * symbol. A migration that adds a table without a durability class goes red
 * here. `reset-table-coverage.integration.test.ts` is the sibling guard for the
 * factory-reset registry.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLazyMastraResetTables } from '../src/reset-table-registry';
import { TABLE_DURABILITY_REGISTRY } from '../src/table-durability-registry';
import { createMigratedTestDb } from './helpers/migrated-test-db';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Registered tables a migrated database legitimately lacks: Mastra's vector and
 * workflow stores create their tables lazily, and `_migrations` is the legacy
 * ledger only the test-only numbered runner creates (production refuses a
 * database that has it). The test asserts they ARE absent, so an entry cannot
 * stay on this list after a migration starts creating it.
 */
const ABSENT_FROM_MIGRATED_DATABASE = new Set<string>([
  ...getLazyMastraResetTables(),
  '_migrations',
]);

/**
 * Whether `source` exports `symbol` as a declaration or an `export { … }`
 * specifier (inline `type` included). `symbol` is interpolated into a RegExp
 * unescaped, which is safe only because every rebuild owner is `\w+` (pinned by
 * the registry unit test).
 */
function sourceExportsSymbol(source: string, symbol: string): boolean {
  const declaration = new RegExp(
    `^export\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|const|let|var|interface|type|enum)\\s+${symbol}\\b`,
    'm'
  );
  if (declaration.test(source)) {
    return true;
  }
  return [...source.matchAll(/^export\s*(?:type\s*)?\{([^}]*)\}/gm)].some(([, specifiers]) =>
    (specifiers ?? '').split(',').some(
      (specifier) =>
        specifier
          .trim()
          .replace(/^type\s+/u, '')
          .split(/\s+as\s+/u)
          .pop()
          ?.trim() === symbol
    )
  );
}

describe('rebuild-owner export check (control)', () => {
  it('accepts every export form and rejects a symbol that is not exported', () => {
    const source = [
      'export async function declaredFn() {}',
      'export class DeclaredClass {}',
      'export const declaredConst = 1;',
      'const local = 1;',
      'export { local as renamedExport, other, type InlineType, type Inner as RenamedType };',
      'export type { OnlyType };',
    ].join('\n');
    for (const symbol of [
      'declaredFn',
      'DeclaredClass',
      'declaredConst',
      'renamedExport',
      'InlineType',
      'RenamedType',
      'OnlyType',
    ]) {
      expect(sourceExportsSymbol(source, symbol), symbol).toBe(true);
    }
    for (const symbol of ['local', 'missing', 'declared', 'Inner', 'type']) {
      expect(sourceExportsSymbol(source, symbol), symbol).toBe(false);
    }
  });
});

describe('tables a migrated database lacks', () => {
  it('are still classified, so a new lazy table cannot go unregistered', () => {
    const registered = new Set(TABLE_DURABILITY_REGISTRY.map((entry) => entry.table));
    for (const table of ABSENT_FROM_MIGRATED_DATABASE) {
      expect(registered.has(table), `${table} has no durability class`).toBe(true);
    }
  });
});

describe('table durability registry (real migrated database)', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  async function sweepPublicTables(): Promise<readonly string[]> {
    const result = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    );
    return result.rows.map((row) => row.tablename);
  }

  it('classifies every public table exactly once', async () => {
    const existing = await sweepPublicTables();
    // Sanity: an empty sweep would make the audit vacuously green.
    expect(existing.length).toBeGreaterThan(20);

    const registered = TABLE_DURABILITY_REGISTRY.map((entry) => entry.table);
    expect(registered.filter((table, index) => registered.indexOf(table) !== index)).toEqual([]);
    expect(
      existing.filter((table) => !registered.includes(table)).sort(),
      'Unclassified table(s). Add each to TABLE_DURABILITY_REGISTRY in packages/db/src/table-durability-registry.ts with a durability class and reason (docs/agents/database.md § "TABLE DURABILITY CLASSES").'
    ).toEqual([]);
  });

  it('only registers tables that exist, apart from the named absent ones', async () => {
    const existing = new Set(await sweepPublicTables());
    for (const { table } of TABLE_DURABILITY_REGISTRY) {
      const expectedPresent = !ABSENT_FROM_MIGRATED_DATABASE.has(table);
      expect(existing.has(table), `${table} should ${expectedPresent ? '' : 'not '}exist`).toBe(
        expectedPresent
      );
    }
  });

  /** Foreign keys from a precious child to a non-precious parent, whatever the delete rule. */
  async function preciousChildrenOfNonPreciousParents(): Promise<
    readonly { child: string; parent: string }[]
  > {
    const durability = new Map(TABLE_DURABILITY_REGISTRY.map((e) => [e.table, e.durability]));
    const result = await db.query<{ child: string; parent: string }>(
      `SELECT DISTINCT child.relname AS child, parent.relname AS parent
         FROM pg_constraint c
         JOIN pg_class child ON child.oid = c.conrelid
         JOIN pg_class parent ON parent.oid = c.confrelid
        WHERE c.contype = 'f' AND child.relnamespace = 'public'::regnamespace`
    );
    // Control: the query must see foreign keys, or the filter below is vacuous.
    expect(result.rows.length).toBeGreaterThan(0);
    return result.rows.filter(
      ({ child, parent }) =>
        durability.get(child) === 'precious' && durability.get(parent) !== 'precious'
    );
  }

  it('never lets a precious table reference a non-precious parent through any foreign key', async () => {
    expect(
      await preciousChildrenOfNonPreciousParents(),
      'TRUNCATE parent CASCADE empties every referencing table whatever its delete rule, and SET NULL / SET DEFAULT rewrite precious rows under a DELETE-based repair.'
    ).toEqual([]);
  });

  it('catches a precious table that references a non-precious parent by a non-cascade rule', async () => {
    await db.exec(`
      ALTER TABLE brainstrike_assistant_thread_groups
        ADD COLUMN probe_no_action text REFERENCES job_queue_metrics(queue);
      ALTER TABLE brainstrike_assistant_thread_placements
        ADD COLUMN probe_set_null text REFERENCES job_queue_metrics(queue) ON DELETE SET NULL;
    `);
    expect(await preciousChildrenOfNonPreciousParents()).toEqual(
      expect.arrayContaining([
        { child: 'brainstrike_assistant_thread_groups', parent: 'job_queue_metrics' },
        { child: 'brainstrike_assistant_thread_placements', parent: 'job_queue_metrics' },
      ])
    );
  });

  it('resolves every derived rebuild owner to an exported symbol', () => {
    const derived = TABLE_DURABILITY_REGISTRY.filter((entry) => entry.durability === 'derived');
    // Control: with no derived entry the loop below proves nothing.
    expect(derived.length).toBeGreaterThan(0);
    for (const entry of derived) {
      const [file, symbol] = (entry.rebuildOwner ?? '').split('#');
      expect(file && symbol, `${entry.table}: rebuildOwner must be path#symbol`).toBeTruthy();
      const source = readFileSync(path.join(REPO_ROOT, file ?? ''), 'utf8');
      expect(
        sourceExportsSymbol(source, symbol ?? ''),
        `${entry.table}: ${file} does not export ${symbol}`
      ).toBe(true);
    }
  });
});
