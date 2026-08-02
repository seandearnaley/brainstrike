import { detectPlatform, type Platform } from '@brainstrike/platform-utils';
import { MockFileSystemAdapter } from './adapters/mock-file-system-adapter.js';
import { WebFileSystemAdapter } from './adapters/web-adapter.js';
import type { FileSystemAdapter } from './types.js';

export function createWebFileSystemAdapter(): FileSystemAdapter {
  return new WebFileSystemAdapter();
}

export function createFileSystemAdapter(platform: Platform): FileSystemAdapter {
  switch (platform) {
    case 'web':
      return createWebFileSystemAdapter();
    case 'electron':
      throw new Error(
        "Electron file system adapter is node-only. Import '@brainstrike/file-system/electron' in Electron main."
      );
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

export function createMockFileSystemAdapter(): FileSystemAdapter {
  return new MockFileSystemAdapter();
}

export { detectPlatform };
