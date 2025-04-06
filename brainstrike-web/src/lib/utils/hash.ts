/**
 * Creates a stable hash from a string.
 * This is a simple but fast hashing function that provides good distribution
 * while being deterministic across sessions.
 *
 * @param str - The string to hash
 * @returns A stable hash string prefixed with 'h' to ensure it's a valid identifier
 */
export function stableHash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash; // Convert to 32bit integer
	}
	// Convert to base36 for shorter strings, prefix with 'h' to ensure it starts with a letter
	return `h${Math.abs(hash).toString(36)}`;
}
