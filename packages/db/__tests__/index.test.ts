import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as exports from '../src/index';
import * as testDataDir from './test-data-dir';

describe('db package exports', () => {
  it('exports all expected functions and classes', () => {
    // Note: FileRecord is a TypeScript type/interface, not a runtime value
    // So we can't test for its existence at runtime, only at compile time

    // Test all runtime exports
    expect(exports).toHaveProperty('migrate');
    expect(typeof exports.migrate).toBe('function');

    expect(exports).toHaveProperty('FileRecordRepository');
    expect(typeof exports.FileRecordRepository).toBe('function');

    expect(exports).toHaveProperty('DbProvider');
    expect(typeof exports.DbProvider).toBe('function');

    expect(exports).toHaveProperty('useFileRecordRepository');
    expect(typeof exports.useFileRecordRepository).toBe('function');

    expect(exports).toHaveProperty('getDefaultDbPath');
    expect(typeof exports.getDefaultDbPath).toBe('function');

    expect(exports).toHaveProperty('wasmLoader');
    expect(exports.wasmLoader).toBeDefined();
  });
});

describe('PGlite test data directory helper', () => {
  it('tracks created directories for deterministic cleanup', async () => {
    const dataDir = testDataDir.createPGliteTestDataDir('pglite-test-cleanup-contract');
    await mkdir(dataDir, { recursive: true });

    expect(existsSync(dataDir)).toBe(true);

    const cleanup = (
      testDataDir as typeof testDataDir & {
        cleanupPGliteTestDataDirs?: () => Promise<void>;
      }
    ).cleanupPGliteTestDataDirs;

    expect(cleanup).toBeTypeOf('function');
    await cleanup?.();

    expect(existsSync(dataDir)).toBe(false);
  });
});
