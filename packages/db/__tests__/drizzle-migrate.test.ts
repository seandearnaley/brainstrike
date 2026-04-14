/**
 * Drizzle Migration Runner Tests
 *
 * Tests the browser-compatible migration runner.
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMigrationStatus, resetMigrations, runMigrations } from '../src/drizzle/migrate.js';

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
    it('should run all migrations successfully', async () => {
      const result = await runMigrations(db);

      expect(result.success).toBe(true);
      expect(result.appliedMigrations.length).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();
    });

    it('should create the vector extension when enabled', async () => {
      await runMigrations(db, { enableVector: true });

      const result = await db.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'"
      );
      expect(result.rows).toHaveLength(1);
    });

    it('should create all expected tables', async () => {
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
      expect(tableNames).toContain('model_registry');
      expect(tableNames).toContain('__drizzle_migrations');
    });

    it('should not re-apply already applied migrations', async () => {
      // Run migrations first time
      const first = await runMigrations(db);
      expect(first.appliedMigrations.length).toBeGreaterThan(0);

      // Run again
      const second = await runMigrations(db);
      expect(second.success).toBe(true);
      expect(second.appliedMigrations).toHaveLength(0);
    });

    it('should call onMigrationStart and onMigrationComplete callbacks', async () => {
      const onStart = vi.fn();
      const onComplete = vi.fn();

      await runMigrations(db, {
        onMigrationStart: onStart,
        onMigrationComplete: onComplete,
      });

      expect(onStart).toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalled();
      expect(onStart.mock.calls.length).toBe(onComplete.mock.calls.length);
    });
  });

  describe('getMigrationStatus', () => {
    it('should return all migrations as pending before running', async () => {
      const status = await getMigrationStatus(db);

      expect(status.total).toBeGreaterThan(0);
      expect(status.applied).toBe(0);
      expect(status.pending.length).toBe(status.total);
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
  });
});
