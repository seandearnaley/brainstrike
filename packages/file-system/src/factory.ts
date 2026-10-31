import { detectPlatform } from '@brainstrike/platform-utils';
import type { FileSystemAdapter } from '@brainstrike/types';
import { MockFileSystemAdapter } from './adapters/mock-file-system-adapter.ts';

export function createMockFileSystemAdapter(): FileSystemAdapter {
  return new MockFileSystemAdapter();
}

export { detectPlatform };
