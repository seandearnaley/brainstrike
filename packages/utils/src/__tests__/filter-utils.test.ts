import { describe, expect, it } from 'vitest';
import { createPathFilterMatcher, processFilter } from '../filter-utils';

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

  describe('createPathFilterMatcher', () => {
    it('includes matching files and prunes excluded directories for glob filters', () => {
      const matcher = createPathFilterMatcher(['*.ts'], ['node_modules/**'], false);

      expect(matcher.shouldIncludeFile('/src/index.ts')).toBe(true);
      expect(matcher.shouldIncludeFile('/src/index.js')).toBe(false);
      expect(matcher.shouldTraverseDirectory('/src')).toBe(true);
      expect(matcher.shouldTraverseDirectory('/node_modules/pkg')).toBe(false);
    });

    it('supports regex matching', () => {
      const matcher = createPathFilterMatcher(['\\.tsx?$'], ['(^|/)dist($|/)'], true);

      expect(matcher.shouldIncludeFile('/src/app.ts')).toBe(true);
      expect(matcher.shouldIncludeFile('/src/app.js')).toBe(false);
      expect(matcher.shouldTraverseDirectory('/dist')).toBe(false);
      expect(matcher.shouldTraverseDirectory('/src')).toBe(true);
    });

    it('throws for invalid regex patterns', () => {
      expect(() => createPathFilterMatcher(['('], [], true)).toThrow(/Invalid regex pattern/);
    });

    it('rejects obviously unsafe nested quantified regex patterns', () => {
      expect(() => createPathFilterMatcher(['(a+)+$'], [], true)).toThrow(
        /Unsafe regex pattern rejected/
      );
    });

    it('allows all files when no include filters are configured', () => {
      const matcher = createPathFilterMatcher([], ['coverage/**'], false);

      expect(matcher.shouldIncludeFile('/src/readme.md')).toBe(true);
      expect(matcher.shouldIncludeFile('/coverage/out.txt')).toBe(false);
    });

    it('matches dotfiles and dot-directories (the "All Files" preset includes *)', () => {
      const matcher = createPathFilterMatcher(['*'], [], false);

      expect(matcher.shouldIncludeFile('/.gitignore')).toBe(true);
      expect(matcher.shouldIncludeFile('/.github/workflows/ci.yml')).toBe(true);
      expect(matcher.shouldIncludeFile('/.devcontainer/devcontainer.json')).toBe(true);
    });

    it('extension globs reach files inside dot-directories', () => {
      const matcher = createPathFilterMatcher(['*.json'], [], false);

      expect(matcher.shouldIncludeFile('/.devcontainer/devcontainer.json')).toBe(true);
      expect(matcher.shouldIncludeFile('/src/app.ts')).toBe(false);
    });
  });
});
