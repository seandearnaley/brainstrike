/**
 * Pre-defined color combinations that ensure good contrast in both light and dark themes.
 * Each combination contains background and text colors for both themes.
 */
const COLOR_COMBINATIONS = [
  {
    dark: { bg: '#1E3A8A', text: '#E6F3FF' },
    light: { bg: '#E6F3FF', text: '#0A558C' }, // Blue
  },
  {
    dark: { bg: '#166534', text: '#E6FFE6' },
    light: { bg: '#E6FFE6', text: '#166534' }, // Green
  },
  {
    dark: { bg: '#9A3412', text: '#FFF1E6' },
    light: { bg: '#FFF1E6', text: '#9A3412' }, // Orange
  },
  {
    dark: { bg: '#6B21A8', text: '#F3E6FF' },
    light: { bg: '#F3E6FF', text: '#6B21A8' }, // Purple
  },
  {
    dark: { bg: '#991B1B', text: '#FFE6E6' },
    light: { bg: '#FFE6E6', text: '#991B1B' }, // Red
  },
  {
    dark: { bg: '#047857', text: '#E6FFFA' },
    light: { bg: '#E6FFFA', text: '#047857' }, // Teal
  },
];

export interface ColorScheme {
  bg: string;
  text: string;
}

export interface FolderColors {
  dark: ColorScheme;
  light: ColorScheme;
}

/**
 * Gets a consistent, accessible color combination for a folder.
 * @param str Input string to generate color from
 * @returns Object with light and dark theme color combinations
 */
export function getFolderColor(str: string): FolderColors {
  // Normalize to lowercase for case-insensitive hashing
  const normalized = str.toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = normalized.charCodeAt(i) + ((hash << 5) - hash);
  }

  // Use the hash to select a color combination
  const index = Math.abs(hash) % COLOR_COMBINATIONS.length;
  // Index is always valid: modulo guarantees 0 <= index < COLOR_COMBINATIONS.length
  // biome-ignore lint/style/noNonNullAssertion: index is bounded by modulo of array length
  return COLOR_COMBINATIONS[index]!;
}
