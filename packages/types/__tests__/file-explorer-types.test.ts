/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest';
import { DEFAULT_STATE } from '../src/file-explorer-types';

describe('DEFAULT_STATE', () => {
  it('should have expected includeFilters', () => {
    expect(DEFAULT_STATE.includeFilters).toEqual([
      '*.tsx',
      '*.ts',
      '*.js',
      '*.jsx',
      '*.json',
    ]);
  });

  it('should have includeProjectTree set to true', () => {
    expect(DEFAULT_STATE.includeProjectTree).toBe(true);
  });
});
