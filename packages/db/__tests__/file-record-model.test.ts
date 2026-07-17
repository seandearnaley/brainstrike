import { describe, expect, it } from 'vitest';
import type { FileRecord } from '../src/models/file-record';

describe('FileRecord model', () => {
  it('FileRecord type structure is correct', () => {
    // This test verifies the TypeScript type at compile time
    // and demonstrates proper usage of the FileRecord interface
    const validFileRecord: FileRecord = {
      createdAt: new Date().toISOString(),
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'test-file.txt',
      path: '/path/to/test-file.txt',
      size: 1024,
      updatedAt: new Date().toISOString(),
    };

    // Verify the structure
    expect(validFileRecord).toHaveProperty('id');
    expect(validFileRecord).toHaveProperty('name');
    expect(validFileRecord).toHaveProperty('path');
    expect(validFileRecord).toHaveProperty('size');
    expect(validFileRecord).toHaveProperty('createdAt');
    expect(validFileRecord).toHaveProperty('updatedAt');

    // Verify types
    expect(typeof validFileRecord.id).toBe('string');
    expect(typeof validFileRecord.name).toBe('string');
    expect(typeof validFileRecord.path).toBe('string');
    expect(typeof validFileRecord.size).toBe('number');
    expect(typeof validFileRecord.createdAt).toBe('string');
    expect(typeof validFileRecord.updatedAt).toBe('string');
  });

  it('FileRecord dates should be ISO string format', () => {
    const now = new Date();
    const fileRecord: FileRecord = {
      createdAt: now.toISOString(),
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'test.txt',
      path: '/test.txt',
      size: 100,
      updatedAt: now.toISOString(),
    };

    // Verify dates can be parsed back
    expect(() => new Date(fileRecord.createdAt)).not.toThrow();
    expect(() => new Date(fileRecord.updatedAt)).not.toThrow();

    // Verify ISO format
    expect(fileRecord.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    expect(fileRecord.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });
});
