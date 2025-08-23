import { detectPlatform } from '@brainstrike/platform-utils';
import { ElectronFileSystemAdapter } from './adapters/electron-adapter';
import { MockFileSystemAdapter } from './adapters/mock-file-system-adapter';
import { WebFileSystemAdapter } from './adapters/web-adapter';
import type { FileSystemAdapter } from './types';

type DetectedPlatform = ReturnType<typeof detectPlatform>;

export function createFileSystemAdapter(platform: DetectedPlatform): FileSystemAdapter {
  switch (platform) {
    case 'web':
      return new WebFileSystemAdapter();
    case 'electron':
      return new ElectronFileSystemAdapter();
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

export function createMockFileSystemAdapter(): FileSystemAdapter {
  return new MockFileSystemAdapter();
}

export { detectPlatform };
