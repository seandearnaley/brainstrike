import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { migrate } from '../src/migrations/bootstrap.js';
import { createFileRecordRepository } from '../src/repositories/repository-factory.js';
import type { FileRecord } from '../src/models/file-record.js';

describe('Migration System Integration', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = new PGlite();
    runner = new MigrationRunner(db);
  });

  describe('full migration workflow', () => {
    it('should run all migrations and create working database schema', async () => {
      await runner.initialize();
      await runner.up(migrations);

      // Verify all migrations were applied
      const applied = await runner.getAppliedMigrations();
      expect(applied).toEqual([1, 2, 3]);

      // Verify the final schema is correct
      const schema = await db.query(`
        SELECT tablename FROM pg_tables 
        WHERE schemaname = 'public' AND tablename != '_migrations'
        ORDER BY tablename
      `);

      // Should contain file_records table
      const tableNames = schema.rows.map((row: any) => row.tablename);
      expect(tableNames).toContain('file_records');

      // Verify vector columns were added
      const columns = await db.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'file_records'
        ORDER BY ordinal_position
      `);
      const columnNames = columns.rows.map((row: any) => row.column_name);
      expect(columnNames).toContain('content');
      expect(columnNames).toContain('embedding');

      // Verify indexes were created
      const indexes = await db.query(`
        SELECT indexname FROM pg_indexes 
        WHERE tablename = 'file_records'
      `);
      expect(indexes.rows.length).toBeGreaterThan(0);
    });

    it('should work with repository after migrations', async () => {
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

    it('should handle migration rollback scenarios', async () => {
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
      const columnNames = columns.rows.map((row: any) => row.column_name);
      expect(columnNames).not.toContain('content');
      expect(columnNames).not.toContain('embedding');

      // But basic data should still be there
      const found = await repository.findById('rollback-test');
      expect(found?.id).toBe('rollback-test');
      expect(found?.name).toBe('rollback.txt');

      // Re-run migrations to get back to full state
      await runner.up(migrations);
      expect(await runner.getCurrentVersion()).toBe(3);
    });
  });

  describe('backward compatibility', () => {
    it('should work with legacy migrate function', async () => {
      await migrate(db);

      // Should have same result as new migration system
      const applied = await runner.getAppliedMigrations();
      expect(applied).toEqual([1, 2, 3]);

      // Repository should work normally
      const repository = createFileRecordRepository(db);
      const count = await repository.count?.();
      expect(count).toBe(0);
    });

    it('should handle mixed usage of old and new systems', async () => {
      // Use legacy system first
      await migrate(db);

      // Then use new system - should recognize existing migrations
      const newRunner = new MigrationRunner(db);
      const applied = await newRunner.getAppliedMigrations();
      expect(applied).toEqual([1, 2, 3]);

      // Running up again should be a no-op
      await newRunner.up(migrations);
      expect(await newRunner.getCurrentVersion()).toBe(3);
    });
  });

  describe('error handling and recovery', () => {
    it('should handle database corruption gracefully', async () => {
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

    it('should maintain data integrity during failed migrations', async () => {
      await runner.initialize();
      await runner.runMigration(migrations[0]); // Initial schema

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
    it('should handle multiple migrations efficiently', async () => {
      const startTime = Date.now();
      
      await runner.initialize();
      await runner.up(migrations);
      
      const duration = Date.now() - startTime;
      
      // Should complete in reasonable time (less than 1 second for test DB)
      expect(duration).toBeLessThan(1000);
      
      // All migrations should be applied
      expect(await runner.getCurrentVersion()).toBe(3);
    });

    it('should handle verification of many migrations efficiently', async () => {
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
    it('should detect when migration files are modified after deployment', async () => {
      await runner.initialize();
      await runner.up(migrations);

      // Simulate a modified migration file
      const modifiedMigrations = migrations.map((migration, index) => {
        if (index === 0) {
          return {
            ...migration,
            up: migration.up + ' -- Modified',
          };
        }
        return migration;
      });

      const isValid = await runner.verify(modifiedMigrations);
      expect(isValid).toBe(false);
    });

    it('should pass validation for unchanged migrations', async () => {
      await runner.initialize();
      await runner.up(migrations);

      // Original migrations should validate correctly
      const isValid = await runner.verify(migrations);
      expect(isValid).toBe(true);
    });
  });
});