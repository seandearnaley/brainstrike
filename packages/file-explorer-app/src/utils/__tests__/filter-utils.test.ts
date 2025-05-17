import { describe, expect, it } from 'vitest';
import { processFilter } from '../filter-utils';

describe('filter-utils', () => {
  describe('processFilter', () => {
    it('should prepend **/ to filters without slashes', () => {
      const filter = '*.ts';
      expect(processFilter(filter)).toBe('**/*.ts');
    });

    it('should not modify filters that already have slashes', () => {
      const filter = 'src/components/*.tsx';
      expect(processFilter(filter)).toBe('src/components/*.tsx');
    });

    it('should handle negated filters by keeping the negation and processing the rest', () => {
      const filter = '!*.js';
      expect(processFilter(filter)).toBe('!**/*.js');
    });

    it('should not modify negated filters that already have slashes', () => {
      const filter = '!src/components/*.jsx';
      expect(processFilter(filter)).toBe('!src/components/*.jsx');
    });

    it('should handle double negation in filters', () => {
      const filter = '!!*.json'; // Double negation
      expect(processFilter(filter)).toBe('!!**/*.json');
    });
  });
});
