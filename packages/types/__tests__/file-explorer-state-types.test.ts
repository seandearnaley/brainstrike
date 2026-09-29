/// <reference types="vitest/globals" />
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE } from '../src/file-explorer-state-types.js';

describe('DEFAULT_STATE', () => {
  it('shows everything by default — include filters are opt-in', () => {
    expect(DEFAULT_STATE.includeFilters).toEqual([]);
  });

  it('excludes .git by default (dot:true globs would otherwise flood the tree)', () => {
    expect(DEFAULT_STATE.excludeFilters).toContain('.git');
  });

  it('should have includeProjectTree set to true', () => {
    expect(DEFAULT_STATE.includeProjectTree).toBe(true);
  });
});
