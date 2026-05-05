import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { ElectronFileRecordRepository } from '../src/repositories/electron-file-record-repository.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';
import {
  createFileRecordRepository,
  type ElectronDbAPI,
  isPGlite,
} from '../src/repositories/repository-factory.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('Repository Factory', () => {
  let db: PGlite | undefined;

  afterEach(async () => {
    if (db) {
      await db.close();
      db = undefined;
    }
  });

  describe('isPGlite type guard', () => {
    it('should correctly identify PGlite instances', { timeout: 30_000 }, async () => {
      const dataDir = `/tmp/pglite-test-repository-factory-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      db = await wasmLoader.createPGlite(dataDir);
      await migrate(db);
      expect(isPGlite(db)).toBe(true);
    });

    it('should correctly identify Electron database API', () => {
      const mockElectronDb: ElectronDbAPI = {
        query: vi.fn(),
        exec: vi.fn(),
      };
      expect(isPGlite(mockElectronDb)).toBe(false);
    });

    it('should return false for null', () => {
      expect(isPGlite(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isPGlite(undefined)).toBe(false);
    });

    it('should return false for plain objects', () => {
      expect(isPGlite({})).toBe(false);
      expect(isPGlite({ query: vi.fn() })).toBe(false);
      expect(isPGlite({ exec: vi.fn() })).toBe(false);
    });

    it('should return false for objects missing required methods', () => {
      const incompleteDb = {
        exec: vi.fn(),
        listen: vi.fn(),
        // Missing 'unlisten' method
      };
      expect(isPGlite(incompleteDb)).toBe(false);
    });

    it('should return false for primitive values', () => {
      expect(isPGlite('string')).toBe(false);
      expect(isPGlite(123)).toBe(false);
      expect(isPGlite(true)).toBe(false);
    });

    it('should handle objects with non-function properties', () => {
      const fakeDb = {
        exec: 'not a function',
        listen: vi.fn(),
        unlisten: vi.fn(),
      };
      expect(isPGlite(fakeDb)).toBe(true); // Type guard only checks existence, not type
    });
  });

  describe('createFileRecordRepository factory', () => {
    it('should create FileRecordRepository for PGlite database', () => {
      const db = new PGlite('memory://');
      const repository = createFileRecordRepository(db);

      expect(repository).toBeInstanceOf(FileRecordRepository);
    });

    it('should create ElectronFileRecordRepository for Electron database', () => {
      const mockElectronDb: ElectronDbAPI = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        exec: vi.fn().mockResolvedValue(undefined),
      };

      const repository = createFileRecordRepository(mockElectronDb);

      expect(repository).toBeInstanceOf(ElectronFileRecordRepository);
    });

    it('should return repositories that implement the same interface', async () => {
      const pgliteDb = new PGlite('memory://');
      const mockElectronDb: ElectronDbAPI = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        exec: vi.fn().mockResolvedValue(undefined),
      };

      const pgliteRepo = createFileRecordRepository(pgliteDb);
      const electronRepo = createFileRecordRepository(mockElectronDb);

      // Both should have the same interface methods
      expect(typeof pgliteRepo.create).toBe('function');
      expect(typeof pgliteRepo.findById).toBe('function');
      expect(typeof pgliteRepo.findAll).toBe('function');
      expect(typeof pgliteRepo.update).toBe('function');
      expect(typeof pgliteRepo.delete).toBe('function');
      expect(typeof pgliteRepo.count).toBe('function');

      expect(typeof electronRepo.create).toBe('function');
      expect(typeof electronRepo.findById).toBe('function');
      expect(typeof electronRepo.findAll).toBe('function');
      expect(typeof electronRepo.update).toBe('function');
      expect(typeof electronRepo.delete).toBe('function');
      expect(typeof electronRepo.count).toBe('function');
    });

    it('should handle edge case where object looks like PGlite but is not', () => {
      const fakePGlite = {
        exec: vi.fn(),
        listen: vi.fn(),
        unlisten: vi.fn(),
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      // Should be treated as PGlite due to type guard
      const repository = createFileRecordRepository(fakePGlite as unknown as PGlite);
      expect(repository).toBeInstanceOf(FileRecordRepository);
    });

    it('should create working repositories that can be used interchangeably', {
      timeout: 40_000,
    }, async () => {
      // Create test databases
      const pgliteDb = new PGlite('memory://');
      await pgliteDb.exec(`
        CREATE TABLE IF NOT EXISTS file_records (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          size INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      const mockElectronDb: ElectronDbAPI = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        exec: vi.fn().mockResolvedValue(undefined),
      };

      const pgliteRepo = createFileRecordRepository(pgliteDb);
      const electronRepo = createFileRecordRepository(mockElectronDb);

      // Test that both repositories can call findAll (different implementations)
      const pgliteResult = await pgliteRepo.findAll();
      expect(Array.isArray(pgliteResult)).toBe(true);

      const electronResult = await electronRepo.findAll();
      expect(Array.isArray(electronResult)).toBe(true);

      // Verify the Electron mock was called
      expect(mockElectronDb.query).toHaveBeenCalled();
    });
  });

  describe('type compatibility', () => {
    it('should accept union types correctly', () => {
      const pgliteDb = new PGlite('memory://');
      const electronDb: ElectronDbAPI = {
        query: vi.fn(),
        exec: vi.fn(),
      };

      // Test that TypeScript accepts both types
      let db: PGlite | ElectronDbAPI;

      db = pgliteDb;
      const repo1 = createFileRecordRepository(db);
      expect(repo1).toBeInstanceOf(FileRecordRepository);

      db = electronDb;
      const repo2 = createFileRecordRepository(db);
      expect(repo2).toBeInstanceOf(ElectronFileRecordRepository);
    });
  });
});
