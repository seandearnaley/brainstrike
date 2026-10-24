import { detectPlatform } from '@brainstrike/platform-utils';
import { MockFileSystemAdapter } from './adapters/mock-file-system-adapter.ts';
import type { FileSystemAdapter } from './types.ts';

export function createMockFileSystemAdapter(): FileSystemAdapter {
  return new MockFileSystemAdapter();
}

export { detectPlatform };
