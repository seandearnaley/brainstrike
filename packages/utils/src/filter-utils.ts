import { Minimatch } from 'minimatch';

const MAX_REGEX_PATTERN_LENGTH = 256;
const DANGEROUS_REGEX_PATTERNS = [
  /\((?:[^()\\]|\\.)*[+*{][^)]*\)[+*{]/,
  /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)[+*{]/,
] as const;

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

export function normalizePathForMatching(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function testRegex(regex: RegExp, path: string): boolean {
  regex.lastIndex = 0;
  return regex.test(path);
}

/**
 * Reject a caller/model-supplied regex SOURCE that is over-long or matches a
 * known catastrophic-backtracking (ReDoS) shape, BEFORE it is compiled or run.
 * Throws with a clear message (no silent fallback). Shared by the glob
 * path-filter below AND the grep authoritative matcher (grep-search-service) so
 * the same guard protects every place a caller pattern becomes a live `RegExp`
 * that is then run per-line across many whole files.
 */
export function assertSafeRegexSource(pattern: string): void {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `Regex pattern exceeds maximum supported length (${MAX_REGEX_PATTERN_LENGTH}): ${pattern}`
    );
  }

  for (const dangerousPattern of DANGEROUS_REGEX_PATTERNS) {
    if (dangerousPattern.test(pattern)) {
      throw new Error(`Unsafe regex pattern rejected (catastrophic backtracking risk): ${pattern}`);
    }
  }
}

function createSafeRegex(pattern: string): RegExp {
  assertSafeRegexSource(pattern);

  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(
      `Invalid regex pattern: ${pattern}${error instanceof Error ? ` (${error.message})` : ''}`
    );
  }
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
    ? processedIncludeFilters.map((pattern) => createSafeRegex(pattern))
    : [];
  const excludeRegexes = useRegex
    ? processedExcludeFilters.map((pattern) => createSafeRegex(pattern))
    : [];
  // dot:true — view filters must see dotfiles (.github/workflows/ci.yml,
  // .devcontainer/devcontainer.json). Without it the "All Files" preset
  // (include '*') silently hides every dot-path. Keep in sync with the
  // display matchers (hooks/filter-engine, utils/tree-generator).
  const includeGlobs = useRegex
    ? []
    : processedIncludeFilters.map((pattern) => new Minimatch(pattern, { dot: true }));
  const excludeGlobs = useRegex
    ? []
    : processedExcludeFilters.map((pattern) => new Minimatch(pattern, { dot: true }));

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
