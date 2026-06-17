import { describe, expect, it, vi } from 'vitest';
import {
  buildWorkspaceLookupCandidates,
  normalizeWorkspaceLookupPath,
} from '../src/workspace-path-utils';

describe('workspace path utilities', () => {
  it('normalizes lookup paths', () => {
    expect(normalizeWorkspaceLookupPath(' ./src\\file.ts ')).toBe('src/file.ts');
    expect(normalizeWorkspaceLookupPath('/src/file.ts')).toBe('src/file.ts');
  });

  it('normalizes lookup paths without replace passes', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace');
    let replaceCalls = 0;
    let normalized = '';
    try {
      normalized = normalizeWorkspaceLookupPath(' .///src\\nested\\file.ts ');
    } finally {
      replaceCalls = replaceSpy.mock.calls.length;
      replaceSpy.mockRestore();
    }

    expect(replaceCalls).toBe(0);
    expect(normalized).toBe('src/nested/file.ts');
  });

  it('builds de-duplicated lookup candidates with slash variants', () => {
    expect(
      buildWorkspaceLookupCandidates(['src/file.ts', '/src/file.ts', './src/file.ts'])
    ).toEqual(['src/file.ts', '/src/file.ts']);
  });
});
