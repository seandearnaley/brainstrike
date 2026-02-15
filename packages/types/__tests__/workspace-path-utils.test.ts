import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceLookupCandidates,
  normalizeWorkspaceLookupPath,
} from '../src/workspace-path-utils';

describe('workspace path utilities', () => {
  it('normalizes lookup paths', () => {
    expect(normalizeWorkspaceLookupPath(' ./src\\file.ts ')).toBe('src/file.ts');
    expect(normalizeWorkspaceLookupPath('/src/file.ts')).toBe('src/file.ts');
  });

  it('builds de-duplicated lookup candidates with slash variants', () => {
    expect(
      buildWorkspaceLookupCandidates(['src/file.ts', '/src/file.ts', './src/file.ts'])
    ).toEqual(['src/file.ts', '/src/file.ts']);
  });
});
