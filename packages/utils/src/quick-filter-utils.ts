export interface FilterPatterns {
  includes: string[];
  excludes: string[];
}

/**
 * Parses a quick filter string into include and exclude patterns.
 */
export function parseFilterString(filter: string): FilterPatterns {
  const terms = filter.trim().split(/\s+/).filter(Boolean);
  return terms.reduce(
    (acc, term) => {
      if (term.startsWith('-')) {
        const excludePattern = term.slice(1).toLowerCase();
        if (excludePattern) {
          acc.excludes.push(excludePattern);
        }
      } else {
        acc.includes.push(term.toLowerCase());
      }
      return acc;
    },
    { includes: [], excludes: [] } as FilterPatterns
  );
}
