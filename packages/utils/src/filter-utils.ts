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
