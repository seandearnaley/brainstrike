import { describe, expect, it } from 'vitest';
import { WebStorageAdapter } from '../adapters/web-storage-adapter.js';
import { createBrowserStorageAdapter } from '../factory.js';

describe('Storage Factory', () => {
  describe('createBrowserStorageAdapter', () => {
    it('should create a browser storage adapter', () => {
      const adapter = createBrowserStorageAdapter();
      expect(adapter).toBeInstanceOf(WebStorageAdapter);
    });
  });
});
