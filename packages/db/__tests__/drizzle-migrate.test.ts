/**
 * Drizzle Migration Runner Tests
 *
 * Tests the browser-compatible migration runner.
 */

import { addLogListener } from '@brainstrike/logging';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMigrationStatus,
  resetMigrations,
  runMigrations,
  splitMigrationStatements,
} from '../src/drizzle/migrate.js';

const MIGRATION_RUN_TIMEOUT_MS = 30_000;
const PREVIOUS_MAGICAL_SENTINEL_HASH =
  '5145d47f81fab2dfcd7cc142f5556cf901b20c5493fe08cfd5020139353a2541';

describe('Drizzle Migration Runner', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await PGlite.create({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });
  });

  afterEach(async () => {
    await db.close();
  });

  describe('runMigrations', () => {
    it(
      'should run all migrations successfully',
      async () => {
        const result = await runMigrations(db);

        expect(result.success).toBe(true);
        expect(result.appliedMigrations.length).toBeGreaterThan(0);
        expect(result.error).toBeUndefined();
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it(
      'should create the vector extension when enabled',
      async () => {
        await runMigrations(db, { enableVector: true });

        const result = await db.query<{ extname: string }>(
          "SELECT extname FROM pg_extension WHERE extname = 'vector'"
        );
        expect(result.rows).toHaveLength(1);
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it(
      'should create all expected tables',
      async () => {
        await runMigrations(db);

        const tables = await db.query<{ tablename: string }>(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
      `);

        const tableNames = tables.rows.map((r) => r.tablename);

        expect(tableNames).toContain('file_records');
        expect(tableNames).toContain('file_chunks');
        expect(tableNames).toContain('embedding_sets');
        expect(tableNames).toContain('job_queue');
        expect(tableNames).toContain('token_cache');
        expect(tableNames).toContain('providers');
        expect(tableNames).toContain('models');
        expect(tableNames).not.toContain('model_registry');
        expect(tableNames).toContain('brainstrike_assistant_run_outcomes');
        expect(tableNames).toContain('brainstrike_assistant_run_errors');
        expect(tableNames).toContain('__drizzle_migrations');

        const diagnosticRunIndex = await db.query<{ indexname: string }>(
          `SELECT indexname
           FROM pg_indexes
           WHERE tablename = 'brainstrike_diagnostic_events'
             AND indexname = 'bst_diagnostic_events_run_idx'`
        );
        expect(diagnosticRunIndex.rows).toEqual([{ indexname: 'bst_diagnostic_events_run_idx' }]);
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it(
      'creates a unique file relationship edge index',
      async () => {
        await runMigrations(db);

        const indexes = await db.query<{ indexname: string }>(`
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'file_relationships'
            AND indexname = 'idx_file_relationships_unique'
        `);

        expect(indexes.rows).toEqual([{ indexname: 'idx_file_relationships_unique' }]);
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it(
      'seeds the production provider and model catalog for greenfield databases',
      async () => {
        await runMigrations(db);

        const localProvider = await db.query<{ id: string; is_enabled: boolean }>(
          "SELECT id, is_enabled FROM providers WHERE id = 'local'"
        );
        const localEmbeddingModel = await db.query<{ id: string; provider_id: string }>(
          "SELECT id, provider_id FROM models WHERE id = 'Xenova/all-MiniLM-L6-v2'"
        );
        // The `local` provider is embeddings-only: its chat model was retired,
        // so a fresh database must carry the embedders and no local chat row.
        const localLlmModels = await db.query<{ id: string }>(
          "SELECT id FROM models WHERE provider_id = 'local' AND capabilities->>'type' = 'llm'"
        );

        expect(localProvider.rows).toEqual([{ id: 'local', is_enabled: true }]);
        expect(localEmbeddingModel.rows).toEqual([
          { id: 'Xenova/all-MiniLM-L6-v2', provider_id: 'local' },
        ]);
        expect(localLlmModels.rows).toEqual([]);
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it(
      'seeds the production view filter presets for greenfield databases',
      async () => {
        await runMigrations(db);

        const presets = await db.query<{ is_default: boolean; name: string }>(`
        SELECT name, is_default
        FROM view_filter_presets
        ORDER BY sort_order
      `);

        expect(presets.rows).toEqual([
          { is_default: true, name: 'TypeScript/JavaScript' },
          { is_default: true, name: 'All Code' },
          { is_default: true, name: 'Documentation' },
          { is_default: true, name: 'Config Files' },
          { is_default: true, name: 'Styles' },
          { is_default: true, name: 'Tests' },
          { is_default: true, name: 'All Files' },
        ]);
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it(
      'should not re-apply already applied migrations',
      async () => {
        // Run migrations first time
        const first = await runMigrations(db);
        expect(first.appliedMigrations.length).toBeGreaterThan(0);

        // Run again
        const second = await runMigrations(db);
        expect(second.success).toBe(true);
        expect(second.appliedMigrations).toHaveLength(0);
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it(
      'refuses to open a ledger carrying hashes this build does not ship',
      async () => {
        // Was "continues when collection indexing stats already exists from the
        // custom migration path", which staged a PARTIALLY-applied drizzle
        // manifest. After the collapse to one current-schema DDL (ADR-0020)
        // there is no partial state: the one hash is either recorded or not.
        //
        // What replaces it is the behaviour that collapse makes load-bearing. A
        // profile built by a previous build carries per-migration hashes this
        // build no longer ships, and it must FAIL VISIBLY rather than be
        // migrated or silently accepted. This is the pre-existing-dev-profile
        // case, asserted on the real boot path.
        await db.query(`
        CREATE TABLE "__drizzle_migrations" (
          id SERIAL PRIMARY KEY,
          hash TEXT NOT NULL UNIQUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        )
      `);
        for (const staleHash of [
          '192587f67d91ef7010f21b9d2fecf03eea37f4f1b902e06281271389c56d6d8b',
          'custom-030-collection-indexing-stats',
          'custom-151-drop-agent-readonly-role',
        ]) {
          await db.query(`INSERT INTO "__drizzle_migrations" (hash) VALUES ($1)`, [staleHash]);
        }

        const result = await runMigrations(db);

        expect(result.success).toBe(false);
        // Named, counted and attributed -- not a bare failure.
        expect(result.error).toContain('greenfield');
        expect(result.error).toContain('must be reset instead of migrated');
        expect(result.error).toContain('3 stale out of 3 applied');
        expect(result.error).toContain('custom-030-collection-indexing-stats');
        // And it did NOT half-apply the schema on the way to refusing.
        const tables = await db.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'file_records'`
        );
        expect(tables.rows).toEqual([{ count: 0 }]);
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it(
      'gives the provider catalog real timestamp defaults, not string literals',
      async () => {
        // Was a grep over drizzle/0008_gifted_unus.sql for
        // "DEFAULT CURRENT_TIMESTAMP" vs "DEFAULT 'CURRENT_TIMESTAMP'". That
        // file is gone with the chain; this asserts the same invariant against
        // the schema the engine actually built, which is what the bug was about.
        await runMigrations(db);

        const defaults = await db.query<{ column_default: string | null; table_name: string }>(
          `SELECT table_name, column_default
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name IN ('providers', 'models')
             AND column_name IN ('created_at', 'updated_at')
           ORDER BY table_name, column_name`
        );

        expect(defaults.rows).toHaveLength(4);
        for (const row of defaults.rows) {
          expect(row.column_default, row.table_name).toBe('now()');
        }
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it(
      'uses ISO UTC text defaults for text timestamp columns',
      async () => {
        await runMigrations(db);

        await db.query(`
        INSERT INTO file_records (id, name, path, size)
        VALUES ('default-timestamp-file', 'default.txt', '/default.txt', 10)
      `);
        await db.query(`
        INSERT INTO job_queue (id, queue, job_type, payload)
        VALUES ('default-timestamp-job', 'embedding', 'embed-chunk', '{}'::jsonb)
      `);
        await db.query(`
        INSERT INTO file_token_cache (
          folder_id,
          file_path,
          content_hash,
          file_size,
          token_count,
          counting_mode
        )
        VALUES ('folder', '/default.txt', 'hash', 10, 4, 'fast')
      `);

        const result = await db.query<{
          file_created_at: string;
          job_run_at: string;
          token_cache_created_at: string;
        }>(`
        SELECT
          (SELECT created_at FROM file_records WHERE id = 'default-timestamp-file') AS file_created_at,
          (SELECT run_at FROM job_queue WHERE id = 'default-timestamp-job') AS job_run_at,
          (
            SELECT created_at
            FROM file_token_cache
            WHERE folder_id = 'folder' AND file_path = '/default.txt'
          ) AS token_cache_created_at
      `);

        const isoUtcTextTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
        expect(result.rows[0]?.file_created_at).toMatch(isoUtcTextTimestamp);
        expect(result.rows[0]?.job_run_at).toMatch(isoUtcTextTimestamp);
        expect(result.rows[0]?.token_cache_created_at).toMatch(isoUtcTextTimestamp);
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it('refuses to run against a reset-required legacy migration ledger', async () => {
      await db.query(`
        CREATE TABLE "_migrations" (
          id SERIAL PRIMARY KEY,
          version INTEGER NOT NULL,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        )
      `);

      const result = await runMigrations(db);

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'Brainstrike DB is greenfield; legacy "_migrations" databases must be reset instead of migrated.'
      );

      const drizzleLedger = await db.query<{ tablename: string }>(`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename = '__drizzle_migrations'
      `);

      expect(drizzleLedger.rows).toHaveLength(0);
    });

    it('refuses to run against a stale Drizzle migration ledger', async () => {
      await db.query(`
        CREATE TABLE "__drizzle_migrations" (
          id SERIAL PRIMARY KEY,
          hash TEXT NOT NULL UNIQUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        )
      `);
      await db.query(`INSERT INTO "__drizzle_migrations" (hash) VALUES ('stale-hash')`);

      const result = await runMigrations(db);

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'Brainstrike DB is greenfield; stale "__drizzle_migrations" databases must be reset instead of migrated.'
      );
      expect(result.error).toContain('Unknown migration hashes (1 stale out of 1 applied)');
      expect(result.appliedMigrations).toHaveLength(0);
    });

    it('refuses the previous magical sentinel hash after the greenfield snapshot rewrite', async () => {
      await db.query(`
        CREATE TABLE "__drizzle_migrations" (
          id SERIAL PRIMARY KEY,
          hash TEXT NOT NULL UNIQUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        )
      `);
      await db.query(`INSERT INTO "__drizzle_migrations" (hash) VALUES ($1)`, [
        PREVIOUS_MAGICAL_SENTINEL_HASH,
      ]);

      const result = await runMigrations(db);

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'Brainstrike DB is greenfield; stale "__drizzle_migrations" databases must be reset instead of migrated.'
      );
      expect(result.error).toContain(PREVIOUS_MAGICAL_SENTINEL_HASH);
      expect(result.appliedMigrations).toHaveLength(0);
    });

    it(
      'should call onMigrationStart and onMigrationComplete callbacks',
      async () => {
        const onStart = vi.fn();
        const onComplete = vi.fn();

        await runMigrations(db, {
          onMigrationComplete: onComplete,
          onMigrationStart: onStart,
        });

        expect(onStart).toHaveBeenCalled();
        expect(onComplete).toHaveBeenCalled();
        expect(onStart.mock.calls.length).toBe(onComplete.mock.calls.length);
      },
      MIGRATION_RUN_TIMEOUT_MS
    );
  });

  describe('splitMigrationStatements', () => {
    it('preserves semicolons and comments inside dollar-quoted SQL blocks', () => {
      const statements = splitMigrationStatements(`
        CREATE FUNCTION test_fn()
        RETURNS void AS $body$
        BEGIN
          RAISE NOTICE 'hello; world';
          -- This comment is function body text and must not be stripped.
        END;
        $body$ LANGUAGE plpgsql;
        SELECT 1;
      `);

      expect(statements).toEqual([
        `CREATE FUNCTION test_fn()
        RETURNS void AS $body$
        BEGIN
          RAISE NOTICE 'hello; world';
          -- This comment is function body text and must not be stripped.
        END;
        $body$ LANGUAGE plpgsql`,
        'SELECT 1',
      ]);
    });

    it('preserves anonymous dollar-quoted SQL blocks', () => {
      const statements = splitMigrationStatements(`
        DO $$
        BEGIN
          PERFORM 1;
          PERFORM 2;
        END;
        $$;
        SELECT 1;
      `);

      expect(statements).toEqual([
        `DO $$
        BEGIN
          PERFORM 1;
          PERFORM 2;
        END;
        $$`,
        'SELECT 1',
      ]);
    });

    it('preserves line-comment markers inside escaped string literals', () => {
      const statements = splitMigrationStatements(`
        INSERT INTO migration_notes (body)
        VALUES (E'it\\'s -- not a comment; still string text');
        SELECT 1;
      `);

      expect(statements).toEqual([
        "INSERT INTO migration_notes (body)\n        VALUES (E'it\\'s -- not a comment; still string text')",
        'SELECT 1',
      ]);
    });

    it('does not treat positional placeholders as dollar-quoted blocks', () => {
      const messages: string[] = [];
      const unsubscribe = addLogListener((record) => {
        if (record.scope === 'DrizzleMigrate' && typeof record.message === 'string') {
          messages.push(record.message);
        }
      });

      let statements: string[];
      try {
        statements = splitMigrationStatements(`
          INSERT INTO migration_notes (id, body) VALUES ($1, $2);
          DO $body$
          BEGIN
            PERFORM 1;
          END;
          $body$;
        `);
      } finally {
        unsubscribe();
      }

      expect(statements).toEqual([
        'INSERT INTO migration_notes (id, body) VALUES ($1, $2)',
        `DO $body$
          BEGIN
            PERFORM 1;
          END;
          $body$`,
      ]);
      expect(messages).not.toContain('Malformed dollar-quoted block in migration SQL');
    });

    it('does not protect dollar-quote markers that start inside single-quoted strings', () => {
      const statements = splitMigrationStatements(`
        INSERT INTO migration_notes (body)
        VALUES ('literal $body$ is not a block');
        SELECT 1;
        SELECT '$body$';
        SELECT 1;
      `);

      expect(statements).toEqual([
        "INSERT INTO migration_notes (body)\n        VALUES ('literal $body$ is not a block')",
        'SELECT 1',
        "SELECT '$body$'",
        'SELECT 1',
      ]);
    });

    it('warns when a dollar-quoted SQL block is missing its closing tag', () => {
      const messages: string[] = [];
      const unsubscribe = addLogListener((record) => {
        if (record.scope === 'DrizzleMigrate' && typeof record.message === 'string') {
          messages.push(record.message);
        }
      });

      try {
        splitMigrationStatements(`
          DO $body$
          BEGIN
            RAISE NOTICE 'unterminated';
          END;
        `);
      } finally {
        unsubscribe();
      }

      expect(messages).toContain('Malformed dollar-quoted block in migration SQL');
    });

    it('keeps an unterminated dollar-quoted block as one malformed statement', () => {
      const statements = splitMigrationStatements(`
        DO $body$
        BEGIN
          PERFORM 1;
        END;
        SELECT 1;
      `);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain('PERFORM 1;');
      expect(statements[0]).toContain('END;');
      expect(statements[0]).toContain('SELECT 1;');
    });
  });

  describe('getMigrationStatus', () => {
    it('should return all migrations as pending before running', async () => {
      const status = await getMigrationStatus(db);

      expect(status.total).toBeGreaterThan(0);
      expect(status.applied).toBe(0);
      expect(status.pending.length).toBe(status.total);
    });

    it('returns all migrations as pending when the Drizzle ledger is missing during diagnostics', async () => {
      const missingLedgerError = new Error('relation "__drizzle_migrations" does not exist');
      Object.assign(missingLedgerError, { code: '42P01' });

      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(missingLedgerError);

      const status = await getMigrationStatus({ query } as unknown as PGlite);

      expect(status.total).toBeGreaterThan(0);
      expect(status.applied).toBe(0);
      expect(status.pending).toHaveLength(status.total);
    });

    it('does not report all migrations as pending when status diagnostics fail unexpectedly', async () => {
      const diagnosticError = new Error('permission denied for schema public');
      Object.assign(diagnosticError, { code: '42501' });

      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(diagnosticError);

      await expect(getMigrationStatus({ query } as unknown as PGlite)).rejects.toThrow(
        'permission denied for schema public'
      );
    });

    it('does not treat unrelated undefined-table errors as a missing Drizzle ledger', async () => {
      const unrelatedMissingTableError = new Error('relation "other_table" does not exist');
      Object.assign(unrelatedMissingTableError, { code: '42P01' });

      const query = vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(unrelatedMissingTableError);

      await expect(getMigrationStatus({ query } as unknown as PGlite)).rejects.toThrow(
        'relation "other_table" does not exist'
      );
    });

    it('refuses status diagnostics against a reset-required legacy migration ledger', async () => {
      await db.query(`
        CREATE TABLE "_migrations" (
          id SERIAL PRIMARY KEY,
          version INTEGER NOT NULL,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        )
      `);

      await expect(getMigrationStatus(db)).rejects.toThrow(
        'Brainstrike DB is greenfield; legacy "_migrations" databases must be reset instead of migrated.'
      );
    });

    it(
      'should return no pending migrations after running',
      async () => {
        await runMigrations(db);

        const status = await getMigrationStatus(db);

        expect(status.total).toBeGreaterThan(0);
        expect(status.applied).toBe(status.total);
        expect(status.pending).toHaveLength(0);
      },
      MIGRATION_RUN_TIMEOUT_MS
    );
  });

  describe('resetMigrations', () => {
    it(
      'should drop all tables',
      async () => {
        // First run migrations
        await runMigrations(db);

        // Verify tables exist
        let tables = await db.query<{ tablename: string }>(`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `);
        expect(tables.rows.length).toBeGreaterThan(0);

        // Reset
        await resetMigrations(db);

        // Verify tables are gone
        tables = await db.query(`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `);
        expect(tables.rows).toHaveLength(0);
      },
      MIGRATION_RUN_TIMEOUT_MS
    );
  });

  describe('Schema validation', () => {
    it(
      'should create file_records with correct columns',
      async () => {
        await runMigrations(db);

        const columns = await db.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'file_records'
        ORDER BY ordinal_position
      `);

        const columnNames = columns.rows.map((c) => c.column_name);

        expect(columnNames).toContain('id');
        expect(columnNames).toContain('name');
        expect(columnNames).toContain('path');
        expect(columnNames).toContain('size');
        expect(columnNames).toContain('content');
        expect(columnNames).toContain('content_hash');
        expect(columnNames).toContain('embedding_set_id');
        // source_root_path retired (migration 040) — root_id is the identity now.
        expect(columnNames).toContain('root_id');
        expect(columnNames).not.toContain('source_root_path');
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it(
      'should create file_chunks with vector column',
      async () => {
        await runMigrations(db);

        const columns = await db.query<{ column_name: string; udt_name: string }>(`
        SELECT column_name, udt_name FROM information_schema.columns
        WHERE table_name = 'file_chunks'
      `);

        const embeddingColumn = columns.rows.find((c) => c.column_name === 'embedding');
        expect(embeddingColumn).toBeDefined();
        expect(embeddingColumn?.udt_name).toBe('vector');
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it(
      'should create proper foreign key constraint',
      async () => {
        await runMigrations(db);

        const fks = await db.query<{ constraint_name: string }>(`
        SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_name = 'file_chunks'
        AND constraint_type = 'FOREIGN KEY'
      `);

        expect(fks.rows.length).toBeGreaterThan(0);
        expect(fks.rows[0]?.constraint_name).toContain('file_record_id');
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it(
      'creates the root_id managed-cache identity index and drops the retired source_root_path one',
      async () => {
        await runMigrations(db);

        const indexes = await db.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'file_records'
      `);
        const names = indexes.rows.map((r) => r.indexname);

        // Migration 039 added the root_id cache-identity index; migration 040
        // dropped the source_root_path (029) one.
        expect(names).toContain('idx_file_records_root_identity');
        expect(names).not.toContain('idx_file_records_cache_identity');
        expect(names).not.toContain('idx_file_records_source_root_path');
      },
      MIGRATION_RUN_TIMEOUT_MS
    );
  });
});
