import { describe, expect, it } from 'vitest';
import { normalizeRootPathForLookup } from '../root-path-lookup';

describe('normalizeRootPathForLookup', () => {
  it('strips trailing separators and surrounding whitespace', () => {
    expect(normalizeRootPathForLookup('/work/ProjectA/')).toBe('/work/ProjectA');
    expect(normalizeRootPathForLookup('  /work/ProjectA  ')).toBe('/work/ProjectA');
    expect(normalizeRootPathForLookup('C:\\work\\ProjectA\\')).toBe('C:\\work\\ProjectA');
  });
});
