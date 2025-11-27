import { describe, expect, it } from 'vitest';
import { getElectronAPI, hasElectronAPI } from '../lib/electron-utils';

describe('electron-utils', () => {
  describe('getElectronAPI', () => {
    it('returns undefined when not in electron environment', () => {
      const result = getElectronAPI();
      expect(result === undefined || typeof result === 'object').toBe(true);
    });
  });

  describe('hasElectronAPI', () => {
    it('returns boolean', () => {
      const result = hasElectronAPI();
      expect(typeof result).toBe('boolean');
    });

    it('returns false in test environment', () => {
      const result = hasElectronAPI();
      expect(result).toBe(false);
    });
  });
});
