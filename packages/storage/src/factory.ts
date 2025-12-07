import { detectPlatform, type Platform } from '@brainstrike/platform-utils';
import { ElectronStorageAdapter } from './adapters/electron-storage-adapter.js';
import { MemoryStorageAdapter } from './adapters/memory-storage-adapter.js';
import { WebStorageAdapter } from './adapters/web-storage-adapter.js';
import type { StorageAdapter } from './types.js';

export function createStorageAdapter(platform: Platform): StorageAdapter {
  switch (platform) {
    case 'web':
      return new WebStorageAdapter();
    case 'electron':
      return new ElectronStorageAdapter();
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

export function createMemoryStorageAdapter(): StorageAdapter {
  return new MemoryStorageAdapter();
}

export { detectPlatform };
