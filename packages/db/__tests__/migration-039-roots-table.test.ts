import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface RootRow {
  display_name: string;
  id: string;
  kind: string;
  path: string | null;
  status: string;
}

interface FileRecordRootRow {
  id: string;
  root_id: string | null;
  source_root_path: string | null;
}

interface CountRow {
  count: number | string;
}

describe('migration 039: roots table', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-roots-table');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 39));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration039() {
    const migration = migrations.find((candidate) => candidate.version === 39);
    if (!migration) {
      throw new Error('Migration 039 is missing');
    }
    return migration;
  }

  // Migration 001 creates created_at/updated_at as TEXT NOT NULL with no
  // DEFAULT on the numbered-runner path, so seeds must supply them.
  async function seedFileRecord(
    id: string,
    path: string,
    sourceRootPath: string | null,
    embeddingSetId: string | null
  ): Promise<void> {
    await db.query(
      `INSERT INTO file_records (id, name, path, size, source_root_path, embedding_set_id, created_at, updated_at)
       VALUES ($1, $2, $3, 0, $4, $5, $6, $6)`,
      [
        id,
        path.split('/').pop() ?? path,
        path,
        sourceRootPath,
        embeddingSetId,
        '2026-06-09T00:00:00.000Z',
      ]
    );
  }

  it('creates one legacy root per distinct source_root_path and backfills root_id', {
    timeout: 60_000,
  }, async () => {
    await seedFileRecord('f1', 'src/index.ts', '/Users/alice/work-docs', 'set-a');
    await seedFileRecord('f2', 'src/index.ts', '/Users/alice/personal-docs', 'set-a');
    await seedFileRecord('f3', 'notes.md', '/Users/alice/work-docs', 'set-a');
    await seedFileRecord('f4', 'orphan.md', null, null);
    await seedFileRecord('f5', 'rootfile.md', '/', 'set-a');
    // Windows path: the [/\\] class in the leaf-extraction must handle
    // backslash separators (the '\\\\'→'[/\\]' SQL escaping is subtle).
    await seedFileRecord('f6', 'a.md', 'C:\\Users\\bob\\docs', 'set-a');
    // Trailing separator: the greedy '^.*[/\\]' would otherwise strip
    // '/Users/alice/trailing/' to '' and COALESCE to the FULL path.
    await seedFileRecord('f7', 'b.md', '/Users/alice/trailing/', 'set-a');

    await runner.runMigration(getMigration039());

    const roots = await db.query<RootRow>('SELECT id, kind, display_name, path, status FROM roots');
    // Sort in JS: SQL ORDER BY on paths mixing '/'-prefixed and 'C:\'-prefixed
    // values is collation-sensitive (C vs ICU order punctuation differently).
    const sortedRoots = roots.rows
      .map((row) => ({
        display_name: row.display_name,
        kind: row.kind,
        path: row.path,
        status: row.status,
      }))
      .sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''));
    expect(sortedRoots).toEqual(
      [
        {
          display_name: '/',
          kind: 'legacy',
          path: '/',
          status: 'live',
        },
        {
          display_name: 'personal-docs',
          kind: 'legacy',
          path: '/Users/alice/personal-docs',
          status: 'live',
        },
        {
          display_name: 'trailing',
          kind: 'legacy',
          path: '/Users/alice/trailing/',
          status: 'live',
        },
        {
          display_name: 'work-docs',
          kind: 'legacy',
          path: '/Users/alice/work-docs',
          status: 'live',
        },
        {
          display_name: 'docs',
          kind: 'legacy',
          path: 'C:\\Users\\bob\\docs',
          status: 'live',
        },
      ].sort((a, b) => a.path.localeCompare(b.path))
    );

    const workRoot = roots.rows.find((row) => row.display_name === 'work-docs');
    const personalRoot = roots.rows.find((row) => row.display_name === 'personal-docs');
    const records = await db.query<FileRecordRootRow>(
      'SELECT id, root_id, source_root_path FROM file_records ORDER BY id'
    );
    const byId = new Map(records.rows.map((row) => [row.id, row]));
    expect(byId.get('f1')?.root_id).toBe(workRoot?.id);
    expect(byId.get('f2')?.root_id).toBe(personalRoot?.id);
    expect(byId.get('f3')?.root_id).toBe(workRoot?.id);
    expect(byId.get('f4')?.root_id).toBeNull();
    const slashRoot = roots.rows.find((row) => row.path === '/');
    expect(byId.get('f5')?.root_id).toBe(slashRoot?.id);
  });

  it('enforces per-root cache identity and cascades file deletion on root removal', {
    timeout: 60_000,
  }, async () => {
    await seedFileRecord('f1', 'src/index.ts', '/Users/alice/work-docs', 'set-a');
    await seedFileRecord('f2', 'src/index.ts', '/Users/alice/personal-docs', 'set-a');

    await runner.runMigration(getMigration039());

    // Same (embedding_set_id, path) from two different roots coexists.
    const distinctRoots = await db.query<CountRow>(
      `SELECT COUNT(DISTINCT root_id)::int AS count FROM file_records WHERE path = 'src/index.ts'`
    );
    expect(Number(distinctRoots.rows[0]?.count ?? 0)).toBe(2);

    // Duplicate (embedding_set_id, root_id, path) is rejected.
    const workRootId = (
      await db.query<{ root_id: string }>(`SELECT root_id FROM file_records WHERE id = 'f1'`)
    ).rows[0]?.root_id;
    expect(workRootId).toBeTruthy();
    // created_at/updated_at supplied: NOT NULL fires before unique
    // constraints, which would mask the duplicate-key assertion.
    await expect(
      db.query(
        `INSERT INTO file_records (id, name, path, size, source_root_path, embedding_set_id, root_id, created_at, updated_at)
           VALUES ('f-dup', 'index.ts', 'src/index.ts', 0, '/Users/alice/work-docs', 'set-a', $1, '2026-06-09T00:00:00.000Z', '2026-06-09T00:00:00.000Z')`,
        [workRootId]
      )
    ).rejects.toThrow(/duplicate key/);

    // Deleting a root cascades to its file records and nobody else's.
    await db.query('DELETE FROM roots WHERE id = $1', [workRootId]);
    const remaining = await db.query<FileRecordRootRow>(
      'SELECT id, root_id, source_root_path FROM file_records ORDER BY id'
    );
    expect(remaining.rows.map((row) => row.id)).toEqual(['f2']);
  });

  it('rollback removes roots artifacts and preserves file records', {
    timeout: 60_000,
  }, async () => {
    await seedFileRecord('f1', 'src/index.ts', '/Users/alice/work-docs', 'set-a');

    const migration = getMigration039();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const rootsTable = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_name = 'roots'`
    );
    expect(Number(rootsTable.rows[0]?.count ?? -1)).toBe(0);

    const rootIdColumn = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.columns
       WHERE table_name = 'file_records' AND column_name = 'root_id'`
    );
    expect(Number(rootIdColumn.rows[0]?.count ?? -1)).toBe(0);

    const records = await db.query<FileRecordRootRow>(
      'SELECT id, source_root_path FROM file_records ORDER BY id'
    );
    expect(records.rows).toEqual([{ id: 'f1', source_root_path: '/Users/alice/work-docs' }]);
  });
});
