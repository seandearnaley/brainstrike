import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, baseMigrations as migrations } from '../src/migrations/index.js';
import type { FileRecord } from '../src/models/file-record.js';
import { createFileRecordRepository } from '../src/repositories/repository-factory.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('Migration System Integration', () => {
  let db: PGlite;
  let runner: MigrationRunner;
  const TEST_TIMEOUT = 60_000;

  // October 2025: Fresh database per test - WASM pre-loaded in vitest.setup.ts
  // Note: Don't run app migrations - tests will run them as part of the test
  beforeEach(async () => {
    const dataDir = `/tmp/pglite-test-migration-integration-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 9)}`;
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

      // Verify all migrations were applied (may include migration 4 if available)
      const applied = await runner.getAppliedMigrations();
      expect(applied.length).toBeGreaterThanOrEqual(3);
      expect(applied).toEqual(expect.arrayContaining([1, 2, 3]));

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
      expect(columnNames).toContain('embedding');

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
        id: 'test-id-1',
        name: 'test.txt',
        path: '/test/test.txt',
        size: 1024,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tokenCount: 0,
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

    it('should handle migration rollback scenarios', { timeout: TEST_TIMEOUT }, async () => {
      await runner.initialize();
      await runner.up(migrations);

      // Create some test data
      const repository = createFileRecordRepository(db);
      const testRecord: FileRecord = {
        id: 'rollback-test',
        name: 'rollback.txt',
        path: '/test/rollback.txt',
        size: 512,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tokenCount: 0,
      };
      await repository.create(testRecord);

      // Rollback to version 1 (should remove vector columns and indexes)
      await runner.down(migrations, 1);

      // Verify we're at version 1
      expect(await runner.getCurrentVersion()).toBe(1);

      // Verify vector columns were removed
      const columns = await db.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'file_records'
        ORDER BY ordinal_position
      `);
      const columnNames = columns.rows.map((row) => (row as { column_name: string }).column_name);
      expect(columnNames).not.toContain('content');
      expect(columnNames).not.toContain('embedding');

      // But basic data should still be there
      const found = await repository.findById('rollback-test');
      expect(found?.id).toBe('rollback-test');
      expect(found?.name).toBe('rollback.txt');

      // Re-run migrations to get back to full state
      await runner.up(migrations);
      expect(await runner.getCurrentVersion()).toBeGreaterThanOrEqual(3);
    });
  });

  describe('error handling and recovery', () => {
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
        id: 'integrity-test',
        name: 'integrity.txt',
        path: '/test/integrity.txt',
        size: 256,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await repository.create(testRecord);

      // Create a bad migration that should fail
      const badMigration = {
        version: 99,
        name: 'bad_migration',
        up: 'ALTER TABLE file_records ADD COLUMN bad_column INVALID_TYPE;',
        down: 'ALTER TABLE file_records DROP COLUMN bad_column;',
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
      expect(await runner.getCurrentVersion()).toBeGreaterThanOrEqual(3);
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
