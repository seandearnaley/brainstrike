import { describe, expect, it } from 'vitest';
import * as exports from '../src/index';

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
