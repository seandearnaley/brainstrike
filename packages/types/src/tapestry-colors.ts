/** Named colors the assistant may assign to a tapestry range. Order is the
 * display/auto-assign palette order and matches the file-explorer COLORS palette. */
export const TAPESTRY_COLOR_NAMES = [
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'pink',
  'gray',
] as const;

export type TapestryColorName = (typeof TAPESTRY_COLOR_NAMES)[number];

/** Single source of truth for name -> hex. Keep in sync with the file-explorer
 * COLORS palette (first 8 match; gray is the de-emphasis color). */
export const TAPESTRY_COLOR_HEX: Record<TapestryColorName, string> = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  cyan: '#06b6d4',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  gray: '#6b7280',
};

export function resolveTapestryColorHex(name: TapestryColorName | undefined): string | undefined {
  return name ? TAPESTRY_COLOR_HEX[name] : undefined;
}
