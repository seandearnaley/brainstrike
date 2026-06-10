import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectPlatform, type Platform, parsePositiveIntegerConfig } from '../index';

describe('Platform Utils', () => {
  describe('detectPlatform', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.clearAllMocks();
    });

    it('should detect web platform by default', () => {
      const platform = detectPlatform();
      expect(platform).toBe('web');
    });

    it('should return correct type', () => {
      const platform: Platform = detectPlatform();
      expect(['web', 'electron']).toContain(platform);
    });

    describe('Electron renderer process detection', () => {
      it('should detect electron renderer process when window.process.type is "renderer"', () => {
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

      it('should not detect electron when window.process.type is not "renderer"', () => {
        const originalWindow = globalThis.window;
        globalThis.window = {
          ...originalWindow,
          process: { type: 'main' },
        } as unknown as typeof globalThis.window;

        const platform = detectPlatform();
        expect(platform).toBe('web');

        // Cleanup
        globalThis.window = originalWindow;
      });

      it('should not detect electron when window.process is undefined', () => {
        const originalWindow = globalThis.window;
        globalThis.window = {
          ...originalWindow,
          process: undefined,
        } as unknown as typeof globalThis.window;

        const platform = detectPlatform();
        expect(platform).toBe('web');

        // Cleanup
        globalThis.window = originalWindow;
      });
    });

    describe('Electron main process detection', () => {
      it('should detect electron main process when globalThis.process.versions.electron exists', () => {
        const originalProcess = (globalThis as { process?: unknown }).process;
        (globalThis as { process: unknown }).process = {
          versions: { electron: '1.0.0' },
        };

        const platform = detectPlatform();
        expect(platform).toBe('electron');

        // Cleanup
        (globalThis as { process?: unknown }).process = originalProcess;
      });

      it('should not detect electron when versions object is missing', () => {
        const originalProcess = (globalThis as { process?: unknown }).process;
        (globalThis as { process: unknown }).process = {
          versions: {},
        };

        const platform = detectPlatform();
        expect(platform).toBe('web');

        // Cleanup
        (globalThis as { process?: unknown }).process = originalProcess;
      });

      it('should not detect electron when versions.electron is undefined', () => {
        const originalProcess = (globalThis as { process?: unknown }).process;
        (globalThis as { process: unknown }).process = {
          versions: { node: '18.0.0' },
        };

        const platform = detectPlatform();
        expect(platform).toBe('web');

        // Cleanup
        (globalThis as { process?: unknown }).process = originalProcess;
      });

      it('should not detect electron when process object is missing', () => {
        const originalProcess = (globalThis as { process?: unknown }).process;
        (globalThis as { process?: unknown }).process = undefined;

        const platform = detectPlatform();
        expect(platform).toBe('web');

        // Cleanup
        (globalThis as { process?: unknown }).process = originalProcess;
      });
    });

    describe('Error handling', () => {
      it('should handle errors gracefully and default to web when window access throws', () => {
        // Mock globalThis to throw error when accessing window
        const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
        Object.defineProperty(globalThis, 'window', {
          get: () => {
            throw new Error('Window access error');
          },
          configurable: true,
        });

        const platform = detectPlatform();
        expect(platform).toBe('web');

        // Cleanup
        if (originalDescriptor) {
          Object.defineProperty(globalThis, 'window', originalDescriptor);
        } else {
          (globalThis as { window?: unknown }).window = undefined;
        }
      });

      it('should handle errors gracefully and default to web when process access throws', () => {
        // Mock globalThis to throw error when accessing process
        const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
        Object.defineProperty(globalThis, 'process', {
          get: () => {
            throw new Error('Process access error');
          },
          configurable: true,
        });

        const platform = detectPlatform();
        expect(platform).toBe('web');

        // Cleanup
        if (originalDescriptor) {
          Object.defineProperty(globalThis, 'process', originalDescriptor);
        } else {
          (globalThis as { process?: unknown }).process = undefined;
        }
      });

      it('should handle errors gracefully when both window and process throw errors', () => {
        // Mock both window and process to throw errors
        const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
        const originalProcessDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');

        Object.defineProperty(globalThis, 'window', {
          get: () => {
            throw new Error('Window error');
          },
          configurable: true,
        });

        Object.defineProperty(globalThis, 'process', {
          get: () => {
            throw new Error('Process error');
          },
          configurable: true,
        });

        const platform = detectPlatform();
        expect(platform).toBe('web');

        // Cleanup
        if (originalWindowDescriptor) {
          Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
        } else {
          (globalThis as { window?: unknown }).window = undefined;
        }

        if (originalProcessDescriptor) {
          Object.defineProperty(globalThis, 'process', originalProcessDescriptor);
        } else {
          (globalThis as { process?: unknown }).process = undefined;
        }
      });
    });

    describe('Edge cases', () => {
      it('should prioritize window.process.type over globalThis.process.versions.electron', () => {
        const originalWindow = globalThis.window;
        const originalProcess = (globalThis as { process?: unknown }).process;

        // Set up both electron indicators
        globalThis.window = {
          ...originalWindow,
          process: { type: 'renderer' },
        } as unknown as typeof globalThis.window;

        (globalThis as { process: unknown }).process = {
          versions: { electron: '1.0.0' },
        };

        const platform = detectPlatform();
        expect(platform).toBe('electron');

        // Cleanup
        globalThis.window = originalWindow;
        (globalThis as { process?: unknown }).process = originalProcess;
      });

      it('should handle window being undefined', () => {
        const originalWindow = globalThis.window;
        (globalThis as { window?: unknown }).window = undefined;

        const platform = detectPlatform();
        expect(platform).toBe('web');

        // Cleanup
        globalThis.window = originalWindow;
      });

      it('should handle null values gracefully', () => {
        const originalWindow = globalThis.window;
        const originalProcess = (globalThis as { process?: unknown }).process;

        globalThis.window = null as unknown as typeof globalThis.window;
        (globalThis as { process?: unknown }).process = null;

        const platform = detectPlatform();
        expect(platform).toBe('web');

        // Cleanup
        globalThis.window = originalWindow;
        (globalThis as { process?: unknown }).process = originalProcess;
      });
    });
  });

  describe('Platform type', () => {
    it('should export Platform type correctly', () => {
      // This test ensures the Platform type is properly exported
      const webPlatform: Platform = 'web';
      const electronPlatform: Platform = 'electron';

      expect(webPlatform).toBe('web');
      expect(electronPlatform).toBe('electron');
    });
  });

  describe('runtime config parsing', () => {
    it('should reject numeric prefixes instead of parsing partial positive integers', () => {
      expect(() =>
        parsePositiveIntegerConfig({
          name: 'PORT',
          rawValue: '9090abc',
        })
      ).toThrow('PORT must be a positive integer, received "9090abc".');
    });
  });
});
