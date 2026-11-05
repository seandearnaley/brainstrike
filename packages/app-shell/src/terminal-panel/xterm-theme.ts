import type { ITheme } from '@xterm/xterm';

/**
 * xterm palettes for the app's light and dark themes.
 *
 * xterm renders to its own surface and cannot read CSS custom properties, so it
 * needs concrete colours. Each palette is an established terminal set (VS Code's
 * Dark+ and Light+ ANSI colours) whose foreground reads at well over 4.5:1 on
 * its own background. `readTerminalAppearance` paints the terminal on the
 * panel's `--background` token so it sits flush with the surrounding chrome,
 * and the terminal's `minimumContrastRatio` lifts any ANSI colour that falls
 * short on that background.
 */
export const XTERM_DARK_THEME: ITheme = {
  background: '#1e1e1e',
  black: '#1e1e1e',
  blue: '#3b8eea',
  brightBlack: '#7f7f7f',
  brightBlue: '#3b8eea',
  brightCyan: '#29b8db',
  brightGreen: '#23d18b',
  brightMagenta: '#d670d6',
  brightRed: '#f14c4c',
  brightWhite: '#ffffff',
  brightYellow: '#f5f543',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  cyan: '#29b8db',
  foreground: '#d4d4d4',
  green: '#23d18b',
  magenta: '#d670d6',
  red: '#f14c4c',
  selectionBackground: 'rgba(120, 120, 120, 0.35)',
  white: '#d4d4d4',
  yellow: '#e5e510',
};

export const XTERM_LIGHT_THEME: ITheme = {
  background: '#ffffff',
  black: '#000000',
  blue: '#0451a5',
  brightBlack: '#666666',
  brightBlue: '#0451a5',
  brightCyan: '#0598bc',
  brightGreen: '#14ce14',
  brightMagenta: '#bc05bc',
  brightRed: '#cd3131',
  brightWhite: '#a5a5a5',
  brightYellow: '#b5ba00',
  cursor: '#333333',
  cursorAccent: '#ffffff',
  cyan: '#0598bc',
  foreground: '#333333',
  green: '#00bc00',
  magenta: '#bc05bc',
  red: '#cd3131',
  selectionBackground: 'rgba(0, 0, 0, 0.15)',
  white: '#555555',
  yellow: '#949800',
};

/** Used only when the `--font-mono` token is unset (e.g. before ThemeProvider writes it). */
export const XTERM_FALLBACK_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** Contrast floor xterm enforces for every cell's foreground. */
export const XTERM_MINIMUM_CONTRAST_RATIO = 4.5;

export interface TerminalAppearance {
  readonly fontFamily: string;
  readonly theme: ITheme;
}

/**
 * The terminal's palette and font for the app theme currently applied to the
 * document: the light/dark class `ThemeProvider` writes on `<html>`, the
 * `--background` token painted behind `element`, and the `--font-mono` stack.
 */
export function readTerminalAppearance(element: HTMLElement): TerminalAppearance {
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  const dark = element.ownerDocument.documentElement.classList.contains('dark');
  const palette = dark ? XTERM_DARK_THEME : XTERM_LIGHT_THEME;
  const background = style?.getPropertyValue('--background').trim() ?? '';
  const fontFamily = style?.getPropertyValue('--font-mono').trim() ?? '';
  return {
    fontFamily: fontFamily === '' ? XTERM_FALLBACK_FONT_FAMILY : fontFamily,
    theme: background === '' ? palette : { ...palette, background, cursorAccent: background },
  };
}
