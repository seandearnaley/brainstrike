import type { ResolvedTheme } from '../hooks/use-resolved-theme';

/**
 * Color configuration for collection items.
 */
export interface CollectionColorResult {
  /** Background color (subtle tint for hover/selected states) */
  background: string;
  /** Primary color for the collection (border, accent, badge) */
  primary: string;
}

/**
 * Sanitize and validate HSL color values to prevent injection.
 * Ensures the value is a finite number and clamped between 0 and max.
 */
function sanitizeHslValue(value: number, max: number): number {
  const clamped = Math.max(0, Math.min(max, value));
  if (!Number.isFinite(clamped)) {
    // Fallback for non-finite numbers to prevent invalid CSS
    return 0;
  }
  return Math.floor(clamped);
}

/**
 * Generate a hash from a string for consistent color generation.
 * Uses djb2 hash algorithm for good distribution.
 */
function hashString(str: string): number {
  if (!str) {
    return 0;
  }
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
  if (parts.length > 1) {
    const providerId = parts[0];
    return providerId ?? null;
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
  const hue = sanitizeHslValue(hash % 360, 360);
  const saturation = sanitizeHslValue(55, 100);
  const lightness = sanitizeHslValue(theme === 'light' ? 40 : 55, 100);

  const primary = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  const bgLightness = sanitizeHslValue(theme === 'light' ? 97 : 15, 100);
  const background = `hsl(${hue}, ${saturation}%, ${bgLightness}%)`;

  return { background, primary };
}
