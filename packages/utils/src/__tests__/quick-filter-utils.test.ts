import { describe, expect, it } from 'vitest';
import { parseFilterString } from '../quick-filter-utils';

describe('quick-filter-utils', () => {
  describe('parseFilterString', () => {
    it('handles include terms', () => {
      const result = parseFilterString('foo bar');
      expect(result).toEqual({ excludes: [], includes: ['foo', 'bar'] });
    });

    it('handles exclude terms', () => {
      const result = parseFilterString('-foo -bar');
      expect(result).toEqual({ excludes: ['foo', 'bar'], includes: [] });
    });

    it('handles mixed terms', () => {
      const result = parseFilterString('foo -bar baz');
      expect(result).toEqual({ excludes: ['bar'], includes: ['foo', 'baz'] });
    });

    it('trims extra whitespace', () => {
      const result = parseFilterString('  foo   -bar  ');
      expect(result).toEqual({ excludes: ['bar'], includes: ['foo'] });
    });
  });
});
