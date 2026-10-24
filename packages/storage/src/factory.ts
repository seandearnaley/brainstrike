import { MemoryStorageAdapter } from './adapters/memory-storage-adapter.js';
import { WebStorageAdapter } from './adapters/web-storage-adapter.js';
import type { StorageAdapter } from './types.js';

export function createBrowserStorageAdapter(): StorageAdapter {
  return new WebStorageAdapter();
}

export function createMemoryStorageAdapter(): StorageAdapter {
  return new MemoryStorageAdapter();
}
