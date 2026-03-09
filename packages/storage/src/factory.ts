import { detectPlatform, type Platform } from '@brainstrike/platform-utils';
import { MemoryStorageAdapter } from './adapters/memory-storage-adapter.js';
import { WebStorageAdapter } from './adapters/web-storage-adapter.js';
import type { StorageAdapter } from './types.js';

export function createBrowserStorageAdapter(): StorageAdapter {
  return new WebStorageAdapter();
}

export function createStorageAdapter(platform: Platform): StorageAdapter {
  switch (platform) {
    case 'web':
      return createBrowserStorageAdapter();
    case 'electron':
      throw new Error(
        "Electron storage adapter is node-only. Import '@brainstrike/storage/electron' in Electron main."
      );
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

export function createMemoryStorageAdapter(): StorageAdapter {
  return new MemoryStorageAdapter();
}

export { detectPlatform };
