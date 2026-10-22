import { detectPlatform } from '@brainstrike/platform-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockFileSystemAdapter } from '../adapters/mock-file-system-adapter.js';
import { createMockFileSystemAdapter } from '../factory.js';

describe('File System Factory', () => {
  describe('createMockFileSystemAdapter', () => {
    it('should create a mock file system adapter', () => {
      const adapter = createMockFileSystemAdapter();
      expect(adapter).toBeInstanceOf(MockFileSystemAdapter);
    });
  });

  describe('detectPlatform', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.clearAllMocks();
    });

    it('should detect web platform by default', () => {
      const platform = detectPlatform();
      expect(platform).toBe('web');
    });

    it('should detect electron renderer process', () => {
      const originalWindow = globalThis.window;
      globalThis.window = {
        ...originalWindow,
        process: { type: 'renderer' },
      } as unknown as typeof globalThis.window;

      const platform = detectPlatform();
      expect(platform).toBe('electron');

      // Cleanup
      globalThis.window = originalWindow;
    });

    it('should detect electron main process', () => {
      const originalProcess = (globalThis as { process?: unknown }).process;
      (globalThis as { process: unknown }).process = {
        versions: { electron: '1.0.0' },
      };

      const platform = detectPlatform();
      expect(platform).toBe('electron');

      // Cleanup
      (globalThis as { process?: unknown }).process = originalProcess;
    });

    it('should handle errors gracefully and default to web', () => {
      // Mock globalThis to throw error
      const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
      Object.defineProperty(globalThis, 'process', {
        configurable: true,
        get: () => {
          throw new Error('Test error');
        },
      });

      const platform = detectPlatform();
      expect(platform).toBe('web');

      // Cleanup
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'process', originalDescriptor);
      }
    });
  });
});
