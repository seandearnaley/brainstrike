import { describe, expect, it } from 'vitest';
import { installRendererErrorHooks } from '../logging/install-renderer-error-hooks';

describe('installRendererErrorHooks - Simple Tests', () => {
  describe('Basic Functionality', () => {
    it('should be a function', () => {
      expect(typeof installRendererErrorHooks).toBe('function');
    });

    it('should return a cleanup function', () => {
      const cleanup = installRendererErrorHooks();

      expect(typeof cleanup).toBe('function');
    });

    it('should execute without throwing', () => {
      expect(() => {
        const cleanup = installRendererErrorHooks();
        cleanup();
      }).not.toThrow();
    });

    it('should accept empty options object', () => {
      expect(() => {
        const cleanup = installRendererErrorHooks({});
        cleanup();
      }).not.toThrow();
    });

    it('should accept options with scope', () => {
      expect(() => {
        const cleanup = installRendererErrorHooks({ scope: 'TestScope' });
        cleanup();
      }).not.toThrow();
    });

    it('should accept options with onError callback', () => {
      const onError = () => {};

      expect(() => {
        const cleanup = installRendererErrorHooks({ onError });
        cleanup();
      }).not.toThrow();
    });

    it('should accept options with both scope and onError', () => {
      const onError = () => {};

      expect(() => {
        const cleanup = installRendererErrorHooks({ scope: 'Custom', onError });
        cleanup();
      }).not.toThrow();
    });

    it('should allow multiple hook installations', () => {
      expect(() => {
        const cleanup1 = installRendererErrorHooks();
        const cleanup2 = installRendererErrorHooks({ scope: 'Second' });
        const cleanup3 = installRendererErrorHooks({ onError: () => {} });

        cleanup1();
        cleanup2();
        cleanup3();
      }).not.toThrow();
    });

    it('should be idempotent - cleanup can be called multiple times', () => {
      const cleanup = installRendererErrorHooks();

      expect(() => {
        cleanup();
        cleanup();
        cleanup();
      }).not.toThrow();
    });
  });
});
