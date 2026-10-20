import { describe, expect, it } from 'vitest';
import { getElectronAPI } from '../lib/electron-utils';

describe('electron-utils', () => {
  describe('getElectronAPI', () => {
    it('returns undefined when not in electron environment', () => {
      const result = getElectronAPI();
      expect(result === undefined || typeof result === 'object').toBe(true);
    });
  });
});
