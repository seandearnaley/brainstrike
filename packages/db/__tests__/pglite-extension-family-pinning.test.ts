import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { afterEach, describe, expect, it } from 'vitest';
import { createPGliteTestDataDir } from './test-data-dir';

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
] as const;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function readPackageManifest(relativePath: string): Promise<PackageManifest> {
  const contents = await readFile(resolve(REPOSITORY_ROOT, relativePath), 'utf8');
  return JSON.parse(contents) as PackageManifest;
}

// The PGlite family moved into the pnpm catalog (BST-748), so consumers now
// declare `catalog:`. Resolve that to the single pinned version in
// pnpm-workspace.yaml so the peer-compatibility guarantee below (one exact
// PGlite family version across every consumer) still holds — now enforced
// centrally by the catalog + verify-catalog-references rather than a hand-synced
// literal in each manifest.
function readCatalogVersions(): Map<string, string> {
  const workspace = readFileSync(resolve(REPOSITORY_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const versions = new Map<string, string>();
  const lines = workspace.split('\n');
  const catalogStart = lines.findIndex((line) => /^catalog:/.test(line));
  for (let index = catalogStart + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined || !/^\s+\S/.test(line)) {
      break;
    }
    const match = line.match(/^\s+'?([^':]+)'?:\s*'?([^'\s]+)'?/);
    const name = match?.[1];
    const version = match?.[2];
    if (name !== undefined && version !== undefined) {
      versions.set(name, version);
    }
  }
  return versions;
}

const CATALOG_VERSIONS = readCatalogVersions();

function dependencyVersion(manifest: PackageManifest, dependencyName: string): string | undefined {
  const declared =
    manifest.dependencies?.[dependencyName] ?? manifest.devDependencies?.[dependencyName];
  return declared === 'catalog:' ? CATALOG_VERSIONS.get(dependencyName) : declared;
}

function openDatabase(dataDir?: string): PGlite {
  return new PGlite({
    ...(dataDir ? { dataDir } : {}),
    extensions: { pg_textsearch: pgTextsearch },
  });
}

/**
 * Two assertions extracted from migration-066's suite, neither of which was
 * about migration machinery.
 *
 * The chain collapsed into one current-schema DDL (ADR-0020), so 066's own
 * cases are gone: its version-guard DO block and its `down` went with the
 * chain, and the guard's intent now lives in
 * __tests__/current-schema-catalog.integration.test.ts, which asserts a fresh
 * boot carries pg_textsearch at exactly QUALIFIED_PG_TEXTSEARCH_VERSION against
 * the frozen catalog fixture.
 *
 * What is kept here is independent of all that:
 *  - the npm/catalog pin, which is repository hygiene, not schema; and
 *  - the durable close-and-reopen BM25 read, which ADR-0020 requires of
 *    current-format data and which the opt-in
 *    pg-textsearch-durability-gate lane does not cover by default.
 */
describe('PGlite extension family pinning', () => {
  let db: PGlite | null = null;

  afterEach(async () => {
    await db?.close();
    db = null;
  });

  it('pins one peer-compatible PGlite extension family across every consumer', async () => {
    for (const manifestPath of PGLITE_CONSUMER_MANIFESTS) {
      const manifest = await readPackageManifest(manifestPath);
      expect(dependencyVersion(manifest, '@electric-sql/pglite'), manifestPath).toBe('0.5.10');
    }

    for (const manifestPath of ['packages/db/package.json'] as const) {
      const manifest = await readPackageManifest(manifestPath);
      expect(dependencyVersion(manifest, '@electric-sql/pglite-pg_textsearch'), manifestPath).toBe(
        '0.0.12'
      );
    }

    for (const manifestPath of ['apps/web/package.json', 'packages/db/package.json'] as const) {
      const manifest = await readPackageManifest(manifestPath);
      expect(dependencyVersion(manifest, '@electric-sql/pglite-pgvector'), manifestPath).toBe(
        '0.0.11'
      );
    }
  });

  it('keeps updated BM25 data readable after a durable close and reopen', async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-pg-textsearch-restore-integrity');
    db = openDatabase(dataDir);
    await db.exec(`
      CREATE TABLE file_chunks (id text PRIMARY KEY, content text NOT NULL);
      CREATE EXTENSION IF NOT EXISTS pg_textsearch;
      -- The shipped definition, as the schema-catalog fixture records it:
      -- text_config is required and the engine rejects the index without it.
      CREATE INDEX idx_file_chunks_content_bm25 ON file_chunks USING bm25 (content) WITH (text_config=english);
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
});
