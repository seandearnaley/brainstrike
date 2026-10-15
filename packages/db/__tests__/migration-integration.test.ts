import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import type { FileRecord } from '../src/models/file-record.js';
import { createFileRecordRepository } from '../src/repositories/repository-factory.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

/**
 * The MigrationRunner against the REAL registry on a real on-disk PGlite.
 *
 * Used `baseMigrations` (the 001-003 subset), which is gone: the chain collapsed
 * into a single current-schema DDL (ADR-0020) and the registry now holds exactly
 * that one step. These cases are unchanged in kind and get STRONGER for it --
 * "works with repository after migrations" now runs against the whole shipped
 * schema instead of the first three chain steps.
 */
describe('Migration System Integration', () => {
  let db: PGlite;
  let runner: MigrationRunner;
  const TEST_TIMEOUT = 60_000;

  // October 2025: Fresh database per test - WASM pre-loaded in vitest.setup.ts
  // Note: Don't run app migrations - tests will run them as part of the test
  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-migration-integration');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    if (db) {
      await db.close();
    }
  });

  describe('full migration workflow', () => {
    it('should run all migrations and create working database schema', {
      timeout: 30_000,
    }, async () => {
      await runner.initialize();
      await runner.up(migrations);

      // The registry is one step since the collapse, and the runner must record
      // exactly it.
      const applied = await runner.getAppliedMigrations();
      expect(applied).toEqual(migrations.map((migration) => migration.version));

      // Verify the final schema is correct
      const schema = await db.query(`
        SELECT tablename FROM pg_tables 
        WHERE schemaname = 'public' AND tablename != '_migrations'
        ORDER BY tablename
      `);
      const tableNames = schema.rows.map((row) => (row as { tablename: string }).tablename);
      expect(tableNames).toContain('file_records');

      // Verify vector columns were added
      const columns = await db.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'file_records'
        ORDER BY ordinal_position
      `);
      const columnNames = columns.rows.map((row) => (row as { column_name: string }).column_name);
      expect(columnNames).toContain('content');
      // NOT `embedding`: `file_records.embedding` existed only on the numbered
      // chain, never in production -- the (now retired)
      // drizzle-migration-parity test's allowlist froze it as the single
      // `numberedOnly` divergence. The registry now builds the PRODUCTION
      // schema, so the column is correctly absent.

      // Verify indexes were created
      const indexes = await db.query(`
        SELECT indexname FROM pg_indexes 
        WHERE tablename = 'file_records'
      `);
      expect(indexes.rows.length).toBeGreaterThan(0);
    });

    it('should work with repository after migrations', { timeout: TEST_TIMEOUT }, async () => {
      await runner.initialize();
      await runner.up(migrations);

      const repository = createFileRecordRepository(db);

      // Test creating a record
      const testRecord: FileRecord = {
        createdAt: new Date().toISOString(),
        id: 'test-id-1',
        name: 'test.txt',
        path: '/test/test.txt',
        size: 1024,
        tokenCount: 0,
        updatedAt: new Date().toISOString(),
      };

      await repository.create(testRecord);

      // Test finding the record
      const found = await repository.findById('test-id-1');
      expect(found).toEqual(testRecord);

      // Test listing all records
      const all = await repository.findAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(testRecord);

      // Test count
      const count = await repository.count?.();
      expect(count).toBe(1);
    });

    it('refuses to roll back a migration that ships no down script', async () => {
      // ADR-0020 does not build migration rollback: a greenfield profile is
      // reset, not reversed. The runner must REFUSE rather than silently
      // report success, so a caller cannot believe a schema was reverted.
      await runner.initialize();
      await runner.up(migrations);

      const [only] = migrations;
      if (!only) {
        throw new Error('The registry must hold the current-schema migration.');
      }
      expect(only.down).toBeUndefined();
      await expect(runner.rollback(only)).rejects.toThrow(/does not support rollback/);
      // The schema is untouched by the refusal.
      expect(await runner.getCurrentVersion()).toBe(only.version);
    });

    it('should handle database corruption gracefully', { timeout: TEST_TIMEOUT }, async () => {
      await runner.initialize();
      await runner.up(migrations);

      // Simulate corruption by dropping the migration table
      await db.exec('DROP TABLE _migrations');

      // Re-initialize should detect and recreate
      await runner.initialize();

      // But applied migrations should be lost, requiring full rebuild
      const applied = await runner.getAppliedMigrations();
      expect(applied).toEqual([]);
    });

    it('should maintain data integrity during failed migrations', {
      timeout: TEST_TIMEOUT,
    }, async () => {
      await runner.initialize();
      const firstMigration = migrations[0];
      if (!firstMigration) {
        throw new Error('No migrations available');
      }
      await runner.runMigration(firstMigration); // Initial schema

      // Create test data
      const repository = createFileRecordRepository(db);
      const testRecord: FileRecord = {
        createdAt: new Date().toISOString(),
        id: 'integrity-test',
        name: 'integrity.txt',
        path: '/test/integrity.txt',
        size: 256,
        updatedAt: new Date().toISOString(),
      };
      await repository.create(testRecord);

      // Create a bad migration that should fail
      const badMigration = {
        down: 'ALTER TABLE file_records DROP COLUMN bad_column;',
        name: 'bad_migration',
        up: 'ALTER TABLE file_records ADD COLUMN bad_column INVALID_TYPE;',
        version: 99,
      };

      // Migration should fail
      await expect(runner.runMigration(badMigration)).rejects.toThrow();

      // But existing data should be intact
      const found = await repository.findById('integrity-test');
      expect(found).toEqual(testRecord);

      // And migration should not be marked as applied
      expect(await runner.isApplied(99)).toBe(false);
    });
  });

  describe('performance and scalability', () => {
    it('should handle multiple migrations efficiently', { timeout: TEST_TIMEOUT }, async () => {
      const startTime = Date.now();

      await runner.initialize();
      await runner.up(migrations);

      const duration = Date.now() - startTime;

      // Should complete in reasonable time (less than 20 seconds, accounting for CI environment variance)
      // Increased from 15s to 20s to handle GitHub runner performance variability
      expect(duration).toBeLessThan(20_000);

      // All migrations should be applied (may be more than 3 if migration 4 is available)
      expect(await runner.getCurrentVersion()).toBe(
        Math.max(...migrations.map((migration) => migration.version))
      );
    });

    it('should handle verification of many migrations efficiently', {
      timeout: TEST_TIMEOUT,
    }, async () => {
      await runner.initialize();
      await runner.up(migrations);

      const startTime = Date.now();
      const isValid = await runner.verify(migrations);
      const duration = Date.now() - startTime;

      expect(isValid).toBe(true);
      expect(duration).toBeLessThan(100); // Verification should be fast
    });
  });

  describe('checksum validation in real scenarios', () => {
    it('should detect when migration files are modified after deployment', {
      timeout: TEST_TIMEOUT,
    }, async () => {
      await runner.initialize();
      await runner.up(migrations);

      // Simulate a modified migration file
      const modifiedMigrations = migrations.map((migration, index) => {
        if (index === 0) {
          return {
            ...migration,
            up: `${migration.up} -- Modified`,
          };
        }
        return migration;
      });

      const isValid = await runner.verify(modifiedMigrations);
      expect(isValid).toBe(false);
    });

    it('should pass validation for unchanged migrations', { timeout: TEST_TIMEOUT }, async () => {
      await runner.initialize();
      await runner.up(migrations);

      // Original migrations should validate correctly
      const isValid = await runner.verify(migrations);
      expect(isValid).toBe(true);
    });
  });
});
