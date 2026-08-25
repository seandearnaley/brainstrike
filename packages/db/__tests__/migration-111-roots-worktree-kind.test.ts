import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';

describe('migration 111: roots worktree kind', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
    runner = new MigrationRunner(db);
    await runner.initialize();
    for (const migration of migrations.filter((candidate) => candidate.version <= 39)) {
      await runner.runMigration(migration);
    }
  });

  afterEach(async () => db.close());

  it('accepts worktree and keeps unknown kinds rejected', async () => {
    const migration = migrations.find((candidate) => candidate.version === 111);
    expect(migration).toBeDefined();
    await db.query(
      `INSERT INTO roots (id, kind, display_name, path)
       VALUES ('root-existing-path', 'path', 'existing path', '/workspace/existing')`
    );
    await runner.runMigration(migration!);

    await expect(
      db.query(
        `INSERT INTO roots (id, kind, display_name, path)
         VALUES ('root-worktree', 'worktree', 'worktree', '/managed/worktree')`
      )
    ).resolves.toBeDefined();
    await expect(
      db.query(
        `INSERT INTO roots (id, kind, display_name, path)
         VALUES ('root-unknown', 'unknown', 'unknown', '/managed/unknown')`
      )
    ).rejects.toThrow(/check constraint/i);
    await expect(
      db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM roots')
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });
});

describe('migration 111 in the drizzle runner', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
  });

  afterEach(async () => db.close());

  it('accepts worktree in the production migration path', {
    timeout: 60_000,
  }, async () => {
    expect((await runMigrations(db)).success).toBe(true);
    await expect(
      db.query(
        `INSERT INTO roots (id, kind, display_name, path)
         VALUES ('root-worktree-drizzle', 'worktree', 'worktree', '/managed/worktree-drizzle')`
      )
    ).resolves.toBeDefined();
    await expect(
      db.query(
        `INSERT INTO roots (id, kind, display_name, path)
         VALUES ('root-unknown-drizzle', 'unknown', 'unknown', '/managed/unknown-drizzle')`
      )
    ).rejects.toThrow(/check constraint/i);
  });
});
