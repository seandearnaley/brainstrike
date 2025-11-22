import { describe, expect, it, vi } from 'vitest';
import { installConsoleGuard } from '../console-guard';

describe('Console Guard - Simple Tests', () => {
  describe('installConsoleGuard', () => {
    it('should be a function', () => {
      expect(typeof installConsoleGuard).toBe('function');
    });

    it('should execute without throwing', () => {
      expect(() => {
        installConsoleGuard();
      }).not.toThrow();
    });

    it('should handle multiple installations without crashing', () => {
      expect(() => {
        installConsoleGuard();
        installConsoleGuard();
        installConsoleGuard();
      }).not.toThrow();
    });

    it('should preserve console methods as functions', () => {
      installConsoleGuard();

      expect(typeof console.log).toBe('function');
      expect(typeof console.info).toBe('function');
      expect(typeof console.warn).toBe('function');
      expect(typeof console.error).toBe('function');
      expect(typeof console.debug).toBe('function');
      expect(typeof console.trace).toBe('function');
    });

    it('should allow console methods to be called', () => {
      installConsoleGuard();

      const logSpy = vi.spyOn(console, 'log');
      const infoSpy = vi.spyOn(console, 'info');

      console.log('test');
      console.info('test');

      expect(logSpy).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalled();

      logSpy.mockRestore();
      infoSpy.mockRestore();
    });
  });
});
