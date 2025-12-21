import type { ResolvedTheme } from '../hooks/use-resolved-theme';

/**
 * Color configuration for collection items.
 */
export type CollectionColorResult = {
  /** Primary color for the collection (border, accent, badge) */
  primary: string;
  /** Background color (subtle tint for hover/selected states) */
  background: string;
};

/**
 * Generate a hash from a string for consistent color generation.
 * Uses djb2 hash algorithm for good distribution.
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) + hash + char;
    hash &= hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Extract provider ID from modelKey (e.g., "openai::text-embedding-3-small" -> "openai")
 */
export function extractProviderId(modelKey: string): string | null {
  const parts = modelKey.split('::');
  if (parts.length > 1 && parts[0]) {
    return parts[0];
  }
  return null;
}

/**
 * Format provider label for display.
 */
export function formatProviderLabel(modelKey: string): string {
  const providerId = extractProviderId(modelKey);
  if (!providerId) {
    return 'Local';
  }
  return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

/**
 * Get collection-specific colors based on unique collection ID.
 *
 * Each collection gets its own unique color based on hashing the collection ID.
 * Colors are designed to work well in both light and dark themes with
 * appropriate contrast and saturation.
 *
 * @param collectionId - Unique collection identifier
 * @param theme - Current theme ('light' or 'dark')
 */
export function getCollectionColor(
  collectionId: string,
  theme: ResolvedTheme
): CollectionColorResult {
  const hash = hashString(collectionId);
  const hue = hash % 360;
  const saturation = 55;
  const lightness = theme === 'light' ? 40 : 55;

  const primary = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  const bgLightness = theme === 'light' ? 97 : 15;
  const background = `hsl(${hue}, ${saturation}%, ${bgLightness}%)`;

  return { primary, background };
}
