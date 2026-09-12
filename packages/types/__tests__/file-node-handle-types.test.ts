import { describe, expectTypeOf, it } from 'vitest';
import type { DirectoryHandle, FileHandle, IFileNode } from '../src/file-system.js';

// The package type-check script compiles this file through tsconfig.test.json.
// Vitest execution alone does not evaluate these compile-time assertions.
describe('file node handle contracts', () => {
  it('accepts canonical adapter descriptors and browser capabilities', () => {
    expectTypeOf<FileHandle>().toExtend<IFileNode['handle']>();
    expectTypeOf<DirectoryHandle>().toExtend<IFileNode['handle']>();
    expectTypeOf<FileSystemFileHandle>().toExtend<IFileNode['handle']>();
    expectTypeOf<FileSystemDirectoryHandle>().toExtend<IFileNode['handle']>();
  });

  it('requires a complete adapter descriptor or browser capability', () => {
    expectTypeOf<{ kind: 'file'; name: string }>().not.toExtend<IFileNode['handle']>();
    expectTypeOf<{
      kind: 'file';
      name: string;
      path: string;
      platform: 'unknown';
    }>().not.toExtend<IFileNode['handle']>();
    expectTypeOf<null>().not.toExtend<IFileNode['handle']>();
  });
});
