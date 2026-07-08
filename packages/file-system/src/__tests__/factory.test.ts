import { detectPlatform } from '@brainstrike/platform-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockFileSystemAdapter } from '../adapters/mock-file-system-adapter';
import { WebFileSystemAdapter } from '../adapters/web-adapter';
import {
  createFileSystemAdapter,
  createMockFileSystemAdapter,
  createWebFileSystemAdapter,
} from '../factory';

describe('File System Factory', () => {
  describe('createFileSystemAdapter', () => {
    it('should create web file system adapter for web platform', () => {
      const adapter = createFileSystemAdapter('web');
      expect(adapter).toBeInstanceOf(WebFileSystemAdapter);
    });

    it('should reject electron adapter creation from the browser-safe entrypoint', () => {
      expect(() => createFileSystemAdapter('electron')).toThrow(
        "Electron file system adapter is node-only. Import '@brainstrike/file-system/electron' in Electron main."
      );
    });

    it('should throw error for unknown platform', () => {
      expect(() => createFileSystemAdapter('unknown' as never)).toThrow(
        'Unknown platform: unknown'
      );
    });
  });

  describe('createMockFileSystemAdapter', () => {
    it('should create a mock file system adapter', () => {
      const adapter = createMockFileSystemAdapter();
      expect(adapter).toBeInstanceOf(MockFileSystemAdapter);
    });
  });

  describe('createWebFileSystemAdapter', () => {
    it('should create a web file system adapter', () => {
      const adapter = createWebFileSystemAdapter();
      expect(adapter).toBeInstanceOf(WebFileSystemAdapter);
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
