import type { BaseDiffOptions } from '@pierre/diffs';
import { useCodeTheme, useThemeMode } from '../theme-provider';
import { codeThemeShikiPair } from '../themes/code-themes';

/**
 * Diffs draw on the app's own surface in its fonts. The theme's background
 * would paint a second surface under every diff, so both scheme backgrounds
 * take the app's; the diff's line tints mix from it.
 */
const DIFF_CSS = `:host {
  --diffs-font-family: var(--font-mono);
  --diffs-header-font-family: var(--font-sans);
  --diffs-light-bg: var(--background);
  --diffs-dark-bg: var(--background);
}`;

export type DiffAppearance = Required<Pick<BaseDiffOptions, 'theme' | 'themeType' | 'unsafeCSS'>>;

/** The user's code theme and light or dark mode, as diff options. */
export function useDiffAppearance(): DiffAppearance {
  return {
    theme: codeThemeShikiPair(useCodeTheme()),
    themeType: useThemeMode(),
    unsafeCSS: DIFF_CSS,
  };
}
