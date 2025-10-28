import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Migration, MigrationRunner } from '../src/migrations/migration-runner.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('MigrationRunner', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  const testMigration1: Migration = {
    version: 1,
    name: 'test_migration_1',
    up: 'CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT);',
    down: 'DROP TABLE test_table;',
  };

  const testMigration2: Migration = {
    version: 2,
    name: 'test_migration_2',
    up: 'ALTER TABLE test_table ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;',
    down: 'ALTER TABLE test_table DROP COLUMN created_at;',
  };

  const testMigration3: Migration = {
    version: 3,
    name: 'test_migration_no_rollback',
    up: 'CREATE INDEX idx_test_name ON test_table(name);',
    // No down migration - testing that rollback is optional
  };

  // October 2025: Fresh database per test - WASM pre-loaded in vitest.setup.ts
  // Note: Don't run app migrations, just initialize the migration tracking table
  beforeEach(async () => {
    const dataDir = `/tmp/pglite-test-migration-runner-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
  });

  afterEach(async () => {
    if (db) {
      await db.close();
    }
  });

  describe('initialization', () => {
    it('should create migration tracking table', async () => {
      // Verify via API that depends on the table
      const applied = await runner.getAppliedMigrations();
      expect(applied).toEqual([]);
    });

    it('should handle repeated initialization calls', async () => {
      await runner.initialize();
      await runner.initialize();

      const applied = await runner.getAppliedMigrations();
      expect(applied).toEqual([]);
    });
  });

  describe('migration tracking', () => {
    it('should start with no applied migrations', async () => {
      const applied = await runner.getAppliedMigrations();
      expect(applied).toEqual([]);
    });

    it('should track current version correctly', async () => {
      expect(await runner.getCurrentVersion()).toBe(0);

      await runner.runMigration(testMigration1);
      expect(await runner.getCurrentVersion()).toBe(1);

      await runner.runMigration(testMigration2);
      expect(await runner.getCurrentVersion()).toBe(2);
    });

    it('should check if migration is applied', async () => {
      expect(await runner.isApplied(1)).toBe(false);

      await runner.runMigration(testMigration1);
      expect(await runner.isApplied(1)).toBe(true);
      expect(await runner.isApplied(2)).toBe(false);
    });

    it('should list applied migrations in order', async () => {
      await runner.runMigration(testMigration1); // Create table first
      await runner.runMigration(testMigration2); // Then alter it

      const applied = await runner.getAppliedMigrations();
      expect(applied).toEqual([1, 2]);
    });
  });

  describe('running migrations', () => {
    it('should run a single migration successfully', async () => {
      await runner.runMigration(testMigration1);

      expect(await runner.isApplied(1)).toBe(true);

      // Verify the actual table was created
      const result = await db.query('SELECT * FROM test_table');
      expect(result.rows).toEqual([]);
    });

    it('should skip already applied migrations', async () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      await runner.runMigration(testMigration1);
      await runner.runMigration(testMigration1); // Second time should skip

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('already applied'));

      consoleSpy.mockRestore();
    });

    it('should run migrations in order with up() method', async () => {
      const migrations = [testMigration2, testMigration1, testMigration3]; // Out of order

      await runner.up(migrations);

      const applied = await runner.getAppliedMigrations();
      expect(applied).toEqual([1, 2, 3]);

      // Verify all changes were applied
      const result = await db.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'test_table' 
        ORDER BY ordinal_position
      `);
      expect(result.rows).toHaveLength(3); // id, name, created_at columns
    });

    it('should handle migration failures with rollback', async () => {
      const badMigration: Migration = {
        version: 99,
        name: 'bad_migration',
        up: 'INVALID SQL SYNTAX HERE;',
        down: 'DROP TABLE nonexistent;',
      };

      await expect(runner.runMigration(badMigration)).rejects.toThrow('Migration 99 failed:');

      expect(await runner.isApplied(99)).toBe(false);
    });
  });

  describe('rollback functionality', () => {
    beforeEach(async () => {
      await runner.runMigration(testMigration1);
      await runner.runMigration(testMigration2);
    });

    it('should rollback a single migration', async () => {
      await runner.rollback(testMigration2);

      expect(await runner.isApplied(2)).toBe(false);
      expect(await runner.isApplied(1)).toBe(true);

      // Verify the column was removed
      const result = await db.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'test_table' 
        ORDER BY ordinal_position
      `);
      expect(result.rows).toHaveLength(2); // Only id and name columns
    });

    it('should rollback to specific version', async () => {
      // Only rollback migrations that have down scripts
      const migrations = [testMigration1, testMigration2];
      await runner.down(migrations, 1);

      expect(await runner.getCurrentVersion()).toBe(1);
      expect(await runner.isApplied(1)).toBe(true);
      expect(await runner.isApplied(2)).toBe(false);
    });

    it('should skip rollback for unapplied migrations', async () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const unappliedMigration: Migration = {
        version: 99,
        name: 'unapplied',
        up: 'CREATE TABLE temp (id INTEGER);',
        down: 'DROP TABLE temp;',
      };

      await runner.rollback(unappliedMigration);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('is not applied'));

      consoleSpy.mockRestore();
    });

    it('should throw error for migration without down script', async () => {
      await runner.runMigration(testMigration3);

      await expect(runner.rollback(testMigration3)).rejects.toThrow(
        'Migration 3 does not support rollback'
      );
    });

    it('should handle rollback failures', async () => {
      const badRollbackMigration: Migration = {
        version: 88,
        name: 'bad_rollback',
        up: 'CREATE TABLE temp_table (id INTEGER);',
        down: 'INVALID ROLLBACK SQL;',
      };

      await runner.runMigration(badRollbackMigration);

      await expect(runner.rollback(badRollbackMigration)).rejects.toThrow(
        'Rollback of migration 88 failed:'
      );
    });
  });

  describe('checksum validation', () => {
    it('should calculate consistent checksums', async () => {
      await runner.runMigration(testMigration1);

      const migrations = [testMigration1];
      const isValid = await runner.verify(migrations);
      expect(isValid).toBe(true);
    });

    it('should detect modified migrations', async () => {
      await runner.runMigration(testMigration1);

      // Create a modified version of the migration
      const modifiedMigration: Migration = {
        ...testMigration1,
        up: 'CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT, modified BOOLEAN);',
      };

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const migrations = [modifiedMigration];
      const isValid = await runner.verify(migrations);
      expect(isValid).toBe(false);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('checksum mismatch'));

      consoleSpy.mockRestore();
    });

    it('should handle verification of unapplied migrations', async () => {
      const migrations = [testMigration1, testMigration2];
      const isValid = await runner.verify(migrations);
      expect(isValid).toBe(true); // Should pass since no migrations are applied
    });
  });

  describe('edge cases', () => {
    it('should handle empty migration list', async () => {
      await runner.up([]);
      expect(await runner.getCurrentVersion()).toBe(0);
    });

    it('should handle rollback to version 0', async () => {
      await runner.runMigration(testMigration1);
      await runner.runMigration(testMigration2);

      const migrations = [testMigration1, testMigration2];
      await runner.down(migrations, 0);

      expect(await runner.getCurrentVersion()).toBe(0);
      expect(await runner.getAppliedMigrations()).toEqual([]);
    });

    it('should handle duplicate version numbers gracefully', async () => {
      const duplicateMigration: Migration = {
        version: 1, // Same as testMigration1
        name: 'duplicate_version',
        up: 'CREATE TABLE duplicate_table (id INTEGER);',
        down: 'DROP TABLE duplicate_table;',
      };

      await runner.runMigration(testMigration1);

      // Second migration with same version should be skipped
      await runner.runMigration(duplicateMigration);

      // Should still only have one migration applied
      const applied = await runner.getAppliedMigrations();
      expect(applied).toEqual([1]);
    });
  });
});
