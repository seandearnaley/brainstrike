import { describe, expect, it, vi } from 'vitest';
import { resetAllMocks, resetStore } from '../test-utils.js';

describe('test-utils', () => {
  describe('resetAllMocks', () => {
    it('should be a function', () => {
      expect(typeof resetAllMocks).toBe('function');
    });

    it('should not throw errors when called', () => {
      expect(() => resetAllMocks()).not.toThrow();
    });

    it('should clear vitest mocks', () => {
      const mockFn = vi.fn();
      mockFn('test');
      expect(mockFn).toHaveBeenCalledWith('test');

      resetAllMocks();

      expect(mockFn).not.toHaveBeenCalled();
    });

    it('should clear multiple mocks', () => {
      const mock1 = vi.fn();
      const mock2 = vi.fn();
      const mock3 = vi.fn();

      mock1('a');
      mock2('b');
      mock3('c');

      expect(mock1).toHaveBeenCalledTimes(1);
      expect(mock2).toHaveBeenCalledTimes(1);
      expect(mock3).toHaveBeenCalledTimes(1);

      resetAllMocks();

      expect(mock1).not.toHaveBeenCalled();
      expect(mock2).not.toHaveBeenCalled();
      expect(mock3).not.toHaveBeenCalled();
    });

    it('should be callable multiple times', () => {
      expect(() => {
        resetAllMocks();
        resetAllMocks();
        resetAllMocks();
      }).not.toThrow();
    });
  });

  describe('resetStore', () => {
    it('should be a function', () => {
      expect(typeof resetStore).toBe('function');
    });

    it('should not throw errors when called', () => {
      expect(() => resetStore()).not.toThrow();
    });

    it('should be callable multiple times', () => {
      expect(() => {
        resetStore();
        resetStore();
        resetStore();
      }).not.toThrow();
    });

    it('should return undefined', () => {
      expect(resetStore()).toBeUndefined();
    });
  });
});
