import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronFileSystemAdapter } from '../adapters/electron-adapter';
import { WebFileSystemAdapter } from '../adapters/web-adapter';
import { createFileSystemAdapter, detectPlatform } from '../factory';

describe('File System Factory', () => {
  describe('createFileSystemAdapter', () => {
    it('should create web file system adapter for web platform', () => {
      const adapter = createFileSystemAdapter('web');
      expect(adapter).toBeInstanceOf(WebFileSystemAdapter);
    });

    it('should create electron file system adapter for electron platform', () => {
      const adapter = createFileSystemAdapter('electron');
      expect(adapter).toBeInstanceOf(ElectronFileSystemAdapter);
    });

    it('should throw error for unknown platform', () => {
      expect(() => createFileSystemAdapter('unknown' as never)).toThrow(
        'Unknown platform: unknown'
      );
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
        get: () => {
          throw new Error('Test error');
        },
        configurable: true,
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
