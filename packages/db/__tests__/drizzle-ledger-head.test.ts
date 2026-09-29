import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeLedgerHead,
  customMigrations,
  getBundledLedgerHead,
} from '../src/drizzle/migrate.js';
import migrationsManifest from '../src/drizzle/migrations.json';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/** The apply order `runMigrations` follows: the drizzle manifest, then the derived custom ones. */
const APPLY_ORDER = [
  ...migrationsManifest.migrations.map((migration) => migration.hash),
  ...customMigrations.map((migration) => migration.hash),
];

describe('getBundledLedgerHead', () => {
  it('is the last hash in apply order, which is the newest custom migration', () => {
    expect(APPLY_ORDER.length).toBeGreaterThan(50);
    expect(getBundledLedgerHead()).toBe(APPLY_ORDER.at(-1));
    expect(getBundledLedgerHead()).toBe(customMigrations.at(-1)?.hash);
  });
});

describe('the bundled ledger is fixed at load', () => {
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
    vi.resetModules();
    vi.doMock('../src/drizzle/migrations.json', () => ({
      default: { generatedAt: '', migrations: [], version: 1 },
    }));
    vi.doMock('../src/migrations/index.js', () => ({ migrations: [] }));
    try {
      const empty = await import('../src/drizzle/migrate.js');
      expect(() => empty.getBundledLedgerHead()).toThrow(/bundles no migrations/u);
      expect(empty.computeLedgerHead(new Set(['x']))).toEqual({ head: null, unknown: 1 });
    } finally {
      vi.doUnmock('../src/drizzle/migrations.json');
      vi.doUnmock('../src/migrations/index.js');
      vi.resetModules();
    }
  });
});

describe('computeLedgerHead', () => {
  it('reports the last applied hash in apply order, whatever order the set was built in', () => {
    const applied = new Set([APPLY_ORDER[5], APPLY_ORDER[2], APPLY_ORDER[0]] as string[]);
    expect(computeLedgerHead(applied)).toEqual({ head: APPLY_ORDER[5], unknown: 0 });
  });

  it('reports the bundled head and no unknowns for a fully migrated ledger', () => {
    expect(computeLedgerHead(new Set(APPLY_ORDER))).toEqual({
      head: getBundledLedgerHead(),
      unknown: 0,
    });
  });

  it('counts applied hashes the bundle does not know, and never lets one become the head', () => {
    const applied = new Set([APPLY_ORDER[1] as string, 'custom-999-from-a-newer-build', 'x']);
    expect(computeLedgerHead(applied)).toEqual({ head: APPLY_ORDER[1], unknown: 2 });
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
