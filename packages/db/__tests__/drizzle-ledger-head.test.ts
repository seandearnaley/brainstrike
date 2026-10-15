import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeLedgerHead,
  customMigrations,
  getBundledLedgerHead,
} from '../src/drizzle/migrate.js';
import type { Migration } from '../src/migrations/migration-runner.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * `getBundledLedgerHead` / `computeLedgerHead` -- kept machinery.
 *
 * The real bundle is now a SINGLE migration (ADR-0020: one current-schema DDL),
 * so it can no longer exercise apply-ORDER on its own: there are no adjacent
 * pairs. The ordering cases therefore run against a mocked multi-entry
 * registry, which is what they always actually needed. Previously they indexed
 * into the shipped bundle (`APPLY_ORDER[5]`), which coupled the ordering logic's
 * coverage to how many migrations happened to ship.
 */

/** Loads `migrate.js` fresh over a registry of exactly these migrations. */
async function withRegistry(
  registry: readonly Migration[],
  assert: (module: typeof import('../src/drizzle/migrate.js')) => void | Promise<void>
): Promise<void> {
  vi.resetModules();
  vi.doMock('../src/migrations/index.js', () => ({ migrations: [...registry] }));
  try {
    await assert(await import('../src/drizzle/migrate.js'));
  } finally {
    vi.doUnmock('../src/migrations/index.js');
    vi.resetModules();
  }
}

function sqlMigration(version: number): Migration {
  return {
    ledgerKey: `custom-${version.toString().padStart(3, '0')}-fixture`,
    name: `fixture_${version}`,
    up: `SELECT ${version};`,
    version,
  };
}

const THREE = [sqlMigration(1), sqlMigration(2), sqlMigration(3)] as const;
const THREE_HASHES = THREE.map((migration) => migration.ledgerKey);

describe('getBundledLedgerHead', () => {
  it('is the newest migration this build ships', () => {
    expect(getBundledLedgerHead()).toBe(customMigrations.at(-1)?.hash);
    // The collapse means that is the one current-schema migration.
    expect(customMigrations).toHaveLength(1);
    expect(getBundledLedgerHead()).toMatch(/^custom-current-schema-[0-9a-f]{64}$/u);
  });

  it('does not move when the exported customMigrations array is appended to afterwards', () => {
    const head = getBundledLedgerHead();
    customMigrations.push({
      hash: 'custom-999-appended-later',
      name: 'x',
      sql: '',
      version: '999',
    });
    try {
      expect(getBundledLedgerHead()).toBe(head);
      expect(computeLedgerHead(new Set(['custom-999-appended-later']))).toEqual({
        head: null,
        unknown: 1,
      });
    } finally {
      customMigrations.pop();
    }
  });
});

describe('a build that bundles no migrations', () => {
  it('has no ledger head and says so, and no applied hash is known to it', async () => {
    await withRegistry([], (empty) => {
      expect(() => empty.getBundledLedgerHead()).toThrow(/bundles no migrations/u);
      expect(empty.computeLedgerHead(new Set(['x']))).toEqual({ head: null, unknown: 1 });
    });
  });
});

describe('computeLedgerHead', () => {
  it('reports the last applied hash in APPLY order, whatever order the set was built in', async () => {
    await withRegistry(THREE, (module) => {
      const applied = new Set([THREE_HASHES[2], THREE_HASHES[0]] as string[]);
      expect(module.computeLedgerHead(applied)).toEqual({ head: THREE_HASHES[2], unknown: 0 });
      // A gap in the middle does not stop the later hash being the head.
      expect(module.computeLedgerHead(new Set([THREE_HASHES[0] as string]))).toEqual({
        head: THREE_HASHES[0],
        unknown: 0,
      });
    });
  });

  it('reports the bundled head and no unknowns for a fully migrated ledger', async () => {
    await withRegistry(THREE, (module) => {
      expect(module.computeLedgerHead(new Set(THREE_HASHES))).toEqual({
        head: module.getBundledLedgerHead(),
        unknown: 0,
      });
    });
  });

  it('counts applied hashes the bundle does not know, and never lets one become the head', async () => {
    await withRegistry(THREE, (module) => {
      const applied = new Set([THREE_HASHES[0] as string, 'custom-999-from-a-newer-build', 'x']);
      expect(module.computeLedgerHead(applied)).toEqual({ head: THREE_HASHES[0], unknown: 2 });
    });
  });

  it('has no head for an empty ledger, and none when every entry is unknown', () => {
    expect(computeLedgerHead(new Set())).toEqual({ head: null, unknown: 0 });
    expect(computeLedgerHead(new Set(['only-unknown']))).toEqual({ head: null, unknown: 1 });
  });
});

describe('a real migrated database', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('has exactly the bundled head in its ledger', async () => {
    const { rows } = await db.query<{ hash: string }>('SELECT hash FROM "__drizzle_migrations"');
    expect(computeLedgerHead(new Set(rows.map((row) => row.hash)))).toEqual({
      head: getBundledLedgerHead(),
      unknown: 0,
    });
  });
});
