import { Minimatch } from 'minimatch';

export function processFilter(filter: string): string {
  // This function is intended for glob patterns, not regex patterns.
  // It prepends '**/' to filters that need it to match files in all subdirectories.
  //
  // Examples:
  //   *.test.tsx → **/*.test.tsx
  //   __tests__/** → **/__tests__/** (match __tests__ at any depth)
  //   **/foo/** → **/foo/** (already recursive)
  //   /absolute → /absolute (absolute path)
  //   !*.js → !**/*.js (negated)

  if (filter.startsWith('!')) {
    return `!${processFilter(filter.slice(1))}`;
  }

  // Already has recursive matching - leave unchanged
  if (filter.startsWith('**/') || filter.startsWith('**')) {
    return filter;
  }

  // Absolute path - leave unchanged
  if (filter.startsWith('/')) {
    return filter;
  }

  // Prepend **/ for recursive matching
  return `**/${filter}`;
}

function normalizePathForMatching(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function testRegex(regex: RegExp, path: string): boolean {
  regex.lastIndex = 0;
  return regex.test(path);
}

export interface PathFilterMatcher {
  shouldIncludeFile: (path: string) => boolean;
  shouldTraverseDirectory: (path: string) => boolean;
}

export function createPathFilterMatcher(
  includeFilters: string[],
  excludeFilters: string[] = [],
  useRegex = false
): PathFilterMatcher {
  const processedIncludeFilters = useRegex ? includeFilters : includeFilters.map(processFilter);
  const processedExcludeFilters = useRegex ? excludeFilters : excludeFilters.map(processFilter);

  const includeRegexes = useRegex
    ? processedIncludeFilters.map((pattern) => new RegExp(pattern))
    : [];
  const excludeRegexes = useRegex
    ? processedExcludeFilters.map((pattern) => new RegExp(pattern))
    : [];
  const includeGlobs = useRegex
    ? []
    : processedIncludeFilters.map((pattern) => new Minimatch(pattern));
  const excludeGlobs = useRegex
    ? []
    : processedExcludeFilters.map((pattern) => new Minimatch(pattern));

  const matchesInclude = (path: string): boolean => {
    if (useRegex) {
      if (includeRegexes.length === 0) {
        return true;
      }
      return includeRegexes.some((regex) => testRegex(regex, path));
    }

    if (includeGlobs.length === 0) {
      return true;
    }

    return includeGlobs.some((matcher) => matcher.match(path));
  };

  const matchesExclude = (path: string): boolean => {
    if (useRegex) {
      return excludeRegexes.some((regex) => testRegex(regex, path));
    }

    return excludeGlobs.some((matcher) => matcher.match(path));
  };

  return {
    shouldIncludeFile(path: string): boolean {
      const normalizedPath = normalizePathForMatching(path);
      return !matchesExclude(normalizedPath) && matchesInclude(normalizedPath);
    },
    shouldTraverseDirectory(path: string): boolean {
      return !matchesExclude(normalizePathForMatching(path));
    },
  };
}
