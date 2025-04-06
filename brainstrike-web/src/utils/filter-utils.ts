export function processFilter(filter: string): string {
	// This function is intended for glob patterns, not regex patterns.
	// It prepends '**/' to filters that don't include a slash to match files in all subdirectories.

	if (filter.startsWith("!")) {
		return `!${processFilter(filter.slice(1))}`;
	}
	return filter.includes("/") ? filter : `**/${filter}`;
}
