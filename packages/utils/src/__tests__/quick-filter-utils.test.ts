import { describe, expect, it } from 'vitest';
import { parseFilterString } from '../quick-filter-utils';

describe('quick-filter-utils', () => {
  describe('parseFilterString', () => {
    it('handles include terms', () => {
      const result = parseFilterString('foo bar');
      expect(result).toEqual({ includes: ['foo', 'bar'], excludes: [] });
    });

    it('handles exclude terms', () => {
      const result = parseFilterString('-foo -bar');
      expect(result).toEqual({ includes: [], excludes: ['foo', 'bar'] });
    });

    it('handles mixed terms', () => {
      const result = parseFilterString('foo -bar baz');
      expect(result).toEqual({ includes: ['foo', 'baz'], excludes: ['bar'] });
    });

    it('trims extra whitespace', () => {
      const result = parseFilterString('  foo   -bar  ');
      expect(result).toEqual({ includes: ['foo'], excludes: ['bar'] });
    });
  });
});
