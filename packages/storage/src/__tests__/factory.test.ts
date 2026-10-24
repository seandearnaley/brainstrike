import { describe, expect, it } from 'vitest';
import { WebStorageAdapter } from '../adapters/web-storage-adapter.ts';
import { createBrowserStorageAdapter } from '../factory.ts';

describe('Storage Factory', () => {
  describe('createBrowserStorageAdapter', () => {
    it('should create a browser storage adapter', () => {
      const adapter = createBrowserStorageAdapter();
      expect(adapter).toBeInstanceOf(WebStorageAdapter);
    });
  });
});
