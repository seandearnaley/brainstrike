import { describe, expect, it } from 'vitest';
import { processFilter } from '../filter-utils';

describe('filter-utils', () => {
  describe('processFilter', () => {
    it('should prepend **/ to simple glob patterns', () => {
      expect(processFilter('*.ts')).toBe('**/*.ts');
      expect(processFilter('*.test.tsx')).toBe('**/*.test.tsx');
    });

    it('should prepend **/ to path patterns for recursive matching', () => {
      // Path patterns like __tests__/** should match at any depth
      expect(processFilter('__tests__/**')).toBe('**/__tests__/**');
      expect(processFilter('src/components/*.tsx')).toBe('**/src/components/*.tsx');
    });

    it('should not modify patterns already starting with **/', () => {
      expect(processFilter('**/foo/**')).toBe('**/foo/**');
      expect(processFilter('**/*.test.ts')).toBe('**/*.test.ts');
    });

    it('should not modify patterns starting with ** (globstar)', () => {
      expect(processFilter('**')).toBe('**');
    });

    it('should not modify absolute paths', () => {
      expect(processFilter('/absolute/path')).toBe('/absolute/path');
    });

    it('should handle negated filters by keeping the negation and processing the rest', () => {
      expect(processFilter('!*.js')).toBe('!**/*.js');
      expect(processFilter('!__tests__/**')).toBe('!**/__tests__/**');
    });

    it('should not modify negated filters that already start with **/', () => {
      expect(processFilter('!**/node_modules/**')).toBe('!**/node_modules/**');
    });

    it('should handle double negation in filters', () => {
      expect(processFilter('!!*.json')).toBe('!!**/*.json');
    });
  });
});
