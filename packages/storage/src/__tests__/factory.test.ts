import { detectPlatform } from '@brainstrike/platform-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronStorageAdapter } from '../adapters/electron-storage-adapter';
import { WebStorageAdapter } from '../adapters/web-storage-adapter';
import { createStorageAdapter } from '../factory';

describe('Storage Factory', () => {
  describe('createStorageAdapter', () => {
    it('should create web storage adapter for web platform', () => {
      const adapter = createStorageAdapter('web');
      expect(adapter).toBeInstanceOf(WebStorageAdapter);
    });

    it('should create electron storage adapter for electron platform', () => {
      const adapter = createStorageAdapter('electron');
      expect(adapter).toBeInstanceOf(ElectronStorageAdapter);
    });

    it('should throw error for unknown platform', () => {
      expect(() => createStorageAdapter('unknown' as never)).toThrow('Unknown platform: unknown');
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
