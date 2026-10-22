import { detectPlatform } from '@brainstrike/platform-utils';
import { MockFileSystemAdapter } from './adapters/mock-file-system-adapter.js';
import type { FileSystemAdapter } from './types.js';

export function createMockFileSystemAdapter(): FileSystemAdapter {
  return new MockFileSystemAdapter();
}

export { detectPlatform };
