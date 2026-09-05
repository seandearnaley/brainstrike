import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/logging', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/logging')>('@brainstrike/logging');
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

import { type Migration, MigrationRunner } from '../src/migrations/migration-runner.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

describe('MigrationRunner', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  const testMigration1: Migration = {
    down: 'DROP TABLE test_table;',
    ledgerKey: 'custom-test-testMigration1',
    name: 'test_migration_1',
    up: 'CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT);',
    version: 1,
  };

  const testMigration2: Migration = {
    down: 'ALTER TABLE test_table DROP COLUMN created_at;',
    ledgerKey: 'custom-test-testMigration2',
    name: 'test_migration_2',
    up: 'ALTER TABLE test_table ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;',
    version: 2,
  };

  const testMigration3: Migration = {
    ledgerKey: 'custom-test-testMigration3',
    name: 'test_migration_no_rollback',
    up: 'CREATE INDEX idx_test_name ON test_table(name);',
    version: 3,
    // No down migration - testing that rollback is optional
  };

  // October 2025: Fresh database per test - WASM pre-loaded in vitest.setup.ts
  // Note: Don't run app migrations, just initialize the migration tracking table
  beforeEach(async () => {
    Object.values(mockLogger).forEach((fn) => {
      fn.mockReset();
    });
    const dataDir = createPGliteTestDataDir('pglite-test-migration-runner');
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
      await runner.runMigration(testMigration1);
      await runner.runMigration(testMigration1); // Second time should skip

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Migration already applied, skipping',
        expect.objectContaining({ version: testMigration1.version })
      );
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

    it('logs cached skips as a single summary entry', async () => {
      await runner.up([testMigration1, testMigration2, testMigration3]);
      mockLogger.debug.mockReset();

      await runner.up([testMigration3, testMigration2, testMigration1]);

      expect(mockLogger.debug).toHaveBeenCalledTimes(1);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Skipped already applied migrations from cache',
        {
          count: 3,
          firstVersion: 1,
          lastVersion: 3,
        }
      );
    });

    it('should handle migration failures with rollback', async () => {
      const badMigration: Migration = {
        down: 'DROP TABLE nonexistent;',
        ledgerKey: 'custom-test-badMigration',
        name: 'bad_migration',
        up: 'INVALID SQL SYNTAX HERE;',
        version: 99,
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
      const unappliedMigration: Migration = {
        down: 'DROP TABLE temp;',
        ledgerKey: 'custom-test-unappliedMigration',
        name: 'unapplied',
        up: 'CREATE TABLE temp (id INTEGER);',
        version: 99,
      };

      await runner.rollback(unappliedMigration);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Migration not applied, skipping rollback',
        expect.objectContaining({ version: 99 })
      );
    });

    it('should throw error for migration without down script', async () => {
      await runner.runMigration(testMigration3);

      await expect(runner.rollback(testMigration3)).rejects.toThrow(
        'Migration 3 does not support rollback'
      );
    });

    it('should handle rollback failures', async () => {
      const badRollbackMigration: Migration = {
        down: 'INVALID ROLLBACK SQL;',
        ledgerKey: 'custom-test-badRollbackMigration',
        name: 'bad_rollback',
        up: 'CREATE TABLE temp_table (id INTEGER);',
        version: 88,
      };

      await runner.runMigration(badRollbackMigration);

      await expect(runner.rollback(badRollbackMigration)).rejects.toThrow(
        'Rollback of migration 88 failed:'
      );
    });

    it('supports function-based rollback migrations', async () => {
      const functionRollbackMigration: Migration = {
        down: async (transactionDb: PGlite) => {
          await transactionDb.exec('DROP TABLE function_rollback_table;');
        },
        ledgerKey: 'custom-test-functionRollbackMigration',
        name: 'function_rollback',
        up: 'CREATE TABLE function_rollback_table (id INTEGER PRIMARY KEY);',
        version: 77,
      };

      await runner.runMigration(functionRollbackMigration);
      await runner.rollback(functionRollbackMigration);

      expect(await runner.isApplied(77)).toBe(false);

      const result = await db.query<{ count: number }>(
        "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_name = 'function_rollback_table'"
      );
      expect(Number(result.rows[0]?.count ?? 0)).toBe(0);
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

      const migrations = [modifiedMigration];
      const isValid = await runner.verify(migrations);
      expect(isValid).toBe(false);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('checksum mismatch'),
        expect.objectContaining({ version: testMigration1.version })
      );
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
        down: 'DROP TABLE duplicate_table;',
        ledgerKey: 'custom-test-duplicateMigration',
        name: 'duplicate_version',
        up: 'CREATE TABLE duplicate_table (id INTEGER);',
        version: 1, // Same as testMigration1
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
