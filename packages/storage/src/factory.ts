import { MemoryStorageAdapter } from './adapters/memory-storage-adapter.ts';
import { WebStorageAdapter } from './adapters/web-storage-adapter.ts';
import type { StorageAdapter } from './types.ts';

export function createBrowserStorageAdapter(): StorageAdapter {
  return new WebStorageAdapter();
}

export function createMemoryStorageAdapter(): StorageAdapter {
  return new MemoryStorageAdapter();
}
