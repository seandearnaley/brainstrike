import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { afterEach, describe, expect, it } from 'vitest';
import { migration066RestorePgTextsearch } from '../src/migrations/066-restore-pg-textsearch';
import { MigrationRunner } from '../src/migrations/migration-runner';
import { QUALIFIED_PG_TEXTSEARCH_VERSION } from '../src/pg-textsearch-compatibility';
import { createPGliteTestDataDir } from './test-data-dir';

interface ExtensionVersionRow {
  extversion: string;
}

interface IndexRow {
  indexname: string;
}

interface RankedRow {
  id: string;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const PGLITE_CONSUMER_MANIFESTS = [
  'apps/desktop/package.json',
  'apps/web/package.json',
  'packages/agent/package.json',
  'packages/db/package.json',
  'packages/embeddings/package.json',
  'packages/file-explorer-ui/package.json',
  'packages/file-import/package.json',
  'packages/token-cache/package.json',
  'packages/vector-management/package.json',
] as const;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function readPackageManifest(relativePath: string): Promise<PackageManifest> {
  const contents = await readFile(resolve(REPOSITORY_ROOT, relativePath), 'utf8');
  return JSON.parse(contents) as PackageManifest;
}

function dependencyVersion(manifest: PackageManifest, dependencyName: string): string | undefined {
  return manifest.dependencies?.[dependencyName] ?? manifest.devDependencies?.[dependencyName];
}

function openDatabase(dataDir?: string): PGlite {
  return new PGlite({
    ...(dataDir ? { dataDir } : {}),
    extensions: { pg_textsearch: pgTextsearch },
  });
}

describe('migration 066: restore qualified pg_textsearch', () => {
  let db: PGlite | null = null;

  afterEach(async () => {
    await db?.close();
    db = null;
  });

  it('pins one peer-compatible PGlite extension family across every consumer', async () => {
    for (const manifestPath of PGLITE_CONSUMER_MANIFESTS) {
      const manifest = await readPackageManifest(manifestPath);
      expect(dependencyVersion(manifest, '@electric-sql/pglite'), manifestPath).toBe('0.5.3');
    }

    for (const manifestPath of ['apps/desktop/package.json', 'packages/db/package.json'] as const) {
      const manifest = await readPackageManifest(manifestPath);
      expect(dependencyVersion(manifest, '@electric-sql/pglite-pg_textsearch'), manifestPath).toBe(
        '0.0.4'
      );
    }

    for (const manifestPath of [
      'apps/desktop/package.json',
      'apps/web/package.json',
      'packages/agent/package.json',
      'packages/db/package.json',
    ] as const) {
      const manifest = await readPackageManifest(manifestPath);
      expect(dependencyVersion(manifest, '@electric-sql/pglite-pgvector'), manifestPath).toBe(
        '0.0.4'
      );
    }
  });

  it('pins the exact qualified engine before creating the BM25 index', async () => {
    db = openDatabase();
    await db.exec('CREATE TABLE file_chunks (id text PRIMARY KEY, content text NOT NULL)');

    await db.exec(migration066RestorePgTextsearch.up as string);

    const extensions = await db.query<ExtensionVersionRow>(
      "SELECT extversion FROM pg_extension WHERE extname = 'pg_textsearch'"
    );
    const indexes = await db.query<IndexRow>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_file_chunks_content_bm25'"
    );

    expect(extensions.rows).toEqual([{ extversion: QUALIFIED_PG_TEXTSEARCH_VERSION }]);
    expect(indexes.rows).toEqual([{ indexname: 'idx_file_chunks_content_bm25' }]);
    expect(migration066RestorePgTextsearch.up).toContain(
      `actual_version IS DISTINCT FROM '${QUALIFIED_PG_TEXTSEARCH_VERSION}'`
    );
    expect(migration066RestorePgTextsearch.up).toContain('refusing to create the BM25 index');
  });

  it('rolls back the extension and index when the version guard rejects', async () => {
    db = openDatabase();
    await db.exec('CREATE TABLE file_chunks (id text PRIMARY KEY, content text NOT NULL)');
    const runner = new MigrationRunner(db);
    await runner.initialize();

    const mismatchedVersionMigration = {
      ...migration066RestorePgTextsearch,
      up: (migration066RestorePgTextsearch.up as string).replaceAll(
        QUALIFIED_PG_TEXTSEARCH_VERSION,
        '0.0.0'
      ),
    };

    await expect(runner.runMigration(mismatchedVersionMigration)).rejects.toThrow(
      'refusing to create the BM25 index'
    );

    const extensions = await db.query<ExtensionVersionRow>(
      "SELECT extversion FROM pg_extension WHERE extname = 'pg_textsearch'"
    );
    const indexes = await db.query<IndexRow>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_file_chunks_content_bm25'"
    );
    expect(extensions.rows).toEqual([]);
    expect(indexes.rows).toEqual([]);
  });

  it('keeps updated BM25 data readable after a durable close and reopen', async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-pg-textsearch-restore-integrity');
    db = openDatabase(dataDir);
    await db.exec(`
      CREATE TABLE file_chunks (id text PRIMARY KEY, content text NOT NULL);
      ${migration066RestorePgTextsearch.up as string}
      INSERT INTO file_chunks (id, content)
      VALUES
        ('chunk-1', 'scheduler recovery indexing'),
        ('chunk-2', 'unrelated document');
      DO $$
      BEGIN
        FOR revision IN 1..250 LOOP
          UPDATE file_chunks
          SET content = 'scheduler recovery revision ' || revision::text
          WHERE id = 'chunk-1';
        END LOOP;
      END
      $$;
      CHECKPOINT;
    `);

    await db.close();
    db = null;
    db = openDatabase(dataDir);

    const ranked = await db.query<RankedRow>(
      `SELECT id
       FROM file_chunks
       ORDER BY content <@> to_bm25query(
         'scheduler recovery',
         'idx_file_chunks_content_bm25'
       )
       LIMIT 2`
    );
    const index = await db.query<IndexRow>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_file_chunks_content_bm25'"
    );

    expect(ranked.rows[0]).toEqual({ id: 'chunk-1' });
    expect(index.rows).toEqual([{ indexname: 'idx_file_chunks_content_bm25' }]);
  });

  it('down removes the index before the extension', async () => {
    db = openDatabase();
    await db.exec('CREATE TABLE file_chunks (id text PRIMARY KEY, content text NOT NULL)');
    await db.exec(migration066RestorePgTextsearch.up as string);

    await db.exec(migration066RestorePgTextsearch.down as string);

    const extensions = await db.query<ExtensionVersionRow>(
      "SELECT extversion FROM pg_extension WHERE extname = 'pg_textsearch'"
    );
    const indexes = await db.query<IndexRow>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_file_chunks_content_bm25'"
    );

    expect(extensions.rows).toEqual([]);
    expect(indexes.rows).toEqual([]);
  });
});
