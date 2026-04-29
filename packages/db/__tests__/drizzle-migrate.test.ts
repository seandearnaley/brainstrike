/**
 * Drizzle Migration Runner Tests
 *
 * Tests the browser-compatible migration runner.
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMigrationStatus,
  resetMigrations,
  runMigrations,
  splitMigrationStatements,
} from '../src/drizzle/migrate.js';
import migrationsManifest from '../src/drizzle/migrations.json';

const MIGRATION_RUN_TIMEOUT_MS = 30_000;

describe('Drizzle Migration Runner', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite({
      extensions: { vector },
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
        expect(tableNames).toContain('__drizzle_migrations');
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
        const localLlmModel = await db.query<{ id: string; provider_id: string }>(
          "SELECT id, provider_id FROM models WHERE id = 'onnx-community/gemma-4-E2B-it-ONNX'"
        );

        expect(localProvider.rows).toEqual([{ id: 'local', is_enabled: true }]);
        expect(localEmbeddingModel.rows).toEqual([
          { id: 'Xenova/all-MiniLM-L6-v2', provider_id: 'local' },
        ]);
        expect(localLlmModel.rows).toEqual([
          { id: 'onnx-community/gemma-4-E2B-it-ONNX', provider_id: 'local' },
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
      'continues when collection indexing stats already exists from the custom migration path',
      async () => {
        const catalogMigrationIndex = migrationsManifest.migrations.findIndex(
          (migration) => migration.name === '0008_gifted_unus'
        );
        expect(catalogMigrationIndex).toBeGreaterThan(0);

        await db.query(`
        CREATE TABLE "__drizzle_migrations" (
          id SERIAL PRIMARY KEY,
          hash TEXT NOT NULL UNIQUE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        )
      `);
        await db.query('CREATE EXTENSION IF NOT EXISTS vector');

        for (const migration of migrationsManifest.migrations.slice(0, catalogMigrationIndex)) {
          const statements = migration.sql
            .split('--> statement-breakpoint')
            .map((statement) => statement.trim())
            .filter((statement) => statement.length > 0);

          for (const statement of statements) {
            await db.query(statement);
          }

          await db.query(`INSERT INTO "__drizzle_migrations" (hash) VALUES ($1)`, [migration.hash]);
        }

        await db.query(
          `INSERT INTO "__drizzle_migrations" (hash) VALUES ('custom-030-collection-indexing-stats')`
        );
        await db.query(`
        CREATE TABLE collection_indexing_stats (
          embedding_set_id TEXT PRIMARY KEY,
          file_count INTEGER NOT NULL DEFAULT 0,
          chunk_count INTEGER NOT NULL DEFAULT 0,
          embedded_chunk_count INTEGER NOT NULL DEFAULT 0,
          pending_chunk_count INTEGER NOT NULL DEFAULT 0,
          dirty BOOLEAN NOT NULL DEFAULT FALSE,
          last_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
        await db.query(`
        CREATE INDEX idx_collection_indexing_stats_dirty
          ON collection_indexing_stats(dirty, last_refreshed_at)
      `);

        const result = await runMigrations(db);

        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.appliedMigrations).toContain('0008_gifted_unus');
        expect(result.appliedMigrations).toContain('0009_great_polaris');
      },
      MIGRATION_RUN_TIMEOUT_MS
    );

    it('does not create provider catalog rows with string-literal timestamp defaults', () => {
      const catalogMigration = migrationsManifest.migrations.find(
        (migration) => migration.name === '0008_gifted_unus'
      );

      expect(catalogMigration?.sql).toContain('DEFAULT CURRENT_TIMESTAMP');
      expect(catalogMigration?.sql).not.toContain("DEFAULT 'CURRENT_TIMESTAMP'");
    });

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
      expect(result.appliedMigrations).toHaveLength(0);
    });

    it(
      'should call onMigrationStart and onMigrationComplete callbacks',
      async () => {
        const onStart = vi.fn();
        const onComplete = vi.fn();

        await runMigrations(db, {
          onMigrationStart: onStart,
          onMigrationComplete: onComplete,
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

    it('should return no pending migrations after running', async () => {
      await runMigrations(db);

      const status = await getMigrationStatus(db);

      expect(status.total).toBeGreaterThan(0);
      expect(status.applied).toBe(status.total);
      expect(status.pending).toHaveLength(0);
    });
  });

  describe('resetMigrations', () => {
    it('should drop all tables', async () => {
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
    });
  });

  describe('Schema validation', () => {
    it('should create file_records with correct columns', async () => {
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
      expect(columnNames).toContain('source_root_path');
    });

    it('should create file_chunks with vector column', async () => {
      await runMigrations(db);

      const columns = await db.query<{ column_name: string; udt_name: string }>(`
        SELECT column_name, udt_name FROM information_schema.columns
        WHERE table_name = 'file_chunks'
      `);

      const embeddingColumn = columns.rows.find((c) => c.column_name === 'embedding');
      expect(embeddingColumn).toBeDefined();
      expect(embeddingColumn?.udt_name).toBe('vector');
    });

    it('should create proper foreign key constraint', async () => {
      await runMigrations(db);

      const fks = await db.query<{ constraint_name: string }>(`
        SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_name = 'file_chunks'
        AND constraint_type = 'FOREIGN KEY'
      `);

      expect(fks.rows.length).toBeGreaterThan(0);
      expect(fks.rows[0]?.constraint_name).toContain('file_record_id');
    });

    it('creates the managed-cache identity unique index for file records', async () => {
      await runMigrations(db);

      const indexes = await db.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'file_records'
          AND indexname = 'idx_file_records_cache_identity'
      `);

      expect(indexes.rows).toHaveLength(1);
      expect(indexes.rows[0]?.indexname).toBe('idx_file_records_cache_identity');
    });
  });
});
