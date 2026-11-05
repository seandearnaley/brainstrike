import type { BaseDiffOptions } from '@pierre/diffs';
import { useCodeTheme, useThemeMode } from '../theme-provider';
import { codeThemeShikiPair } from '../themes/code-themes';

/**
 * Diffs draw on the app's own surface in its fonts, at the code font size
 * chosen in Settings > Appearance when there is one (the renderer's own 13px
 * on a 20px line otherwise). The theme's background
 * would paint a second surface under every diff, so both scheme backgrounds
 * take the app's; the diff's line tints mix from it.
 */
const DIFF_CSS = `:host {
  --diffs-font-family: var(--font-mono);
  --diffs-font-size: var(--code-font-size, 13px);
  --diffs-line-height: var(--code-line-height, 20px);
  --diffs-header-font-family: var(--font-sans);
  --diffs-light-bg: var(--background);
  --diffs-dark-bg: var(--background);
}`;

export type DiffAppearance = Required<
  Pick<BaseDiffOptions, 'preferredHighlighter' | 'theme' | 'themeType' | 'unsafeCSS'>
>;

/**
 * The user's code theme and light or dark mode, as diff options, highlighted
 * by @pierre/highlights (WebAssembly, the vendor's fastest backend) on the
 * main thread. Measured in Chromium on a 3,000-line rewrite, Shiki held the
 * main thread 1.7 s warm and 3.6 s cold; this backend took 0.12 s, and a
 * worker pool of Shiki painted the first line 0.8 s later. Across 200 files
 * scrolled end to end, main-thread work fell from 352 ms to 67 ms.
 */
export function useDiffAppearance(): DiffAppearance {
  return {
    preferredHighlighter: 'highlights',
    theme: codeThemeShikiPair(useCodeTheme()),
    themeType: useThemeMode(),
    unsafeCSS: DIFF_CSS,
  };
}
