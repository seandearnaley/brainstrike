import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as exports from '../src/index';
// BST-990 seam: React surface moved to the ./react entry; the root barrel is
// deliberately React-free (its export-star loaded React in Electron main).
import * as reactExports from '../src/react';
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

    expect(exports).toHaveProperty('wasmLoader');
    expect(exports.wasmLoader).toBeDefined();

    // The root barrel must NOT carry the React surface…
    expect(exports).not.toHaveProperty('DbProvider');
    expect(exports).not.toHaveProperty('useFileRecordRepository');
    // …the ./react entry must.
    expect(typeof reactExports.DbProvider).toBe('function');
    expect(typeof reactExports.useFileRecordRepository).toBe('function');
    expect(typeof reactExports.getDefaultDbPath).toBe('function');
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

  it('does not register module-level cleanup for unrelated tests in importing files', () => {
    const source = readFileSync(join(process.cwd(), '__tests__/test-data-dir.ts'), 'utf8');

    expect(source).toContain('onTestFinished');
    expect(source).not.toContain('afterEach');
  });
});
