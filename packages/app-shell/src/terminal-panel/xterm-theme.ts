import type { ITheme } from '@xterm/xterm';

/**
 * xterm theme aligned with the app shell.
 *
 * xterm renders to a canvas and cannot read CSS custom properties (`--background`
 * etc.), so a concrete palette is required. `background: 'transparent'` lets the
 * panel's own themed background show through, so the terminal tracks light/dark
 * automatically; the foreground + ANSI palette use a neutral 16-color set that
 * reads well on both. The panel wraps this in a `bg-background text-foreground`
 * container so the surrounding chrome stays themed.
 */
export const XTERM_THEME: ITheme = {
  background: 'transparent',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: 'rgba(120, 120, 120, 0.35)',
  black: '#1e1e1e',
  red: '#f14c4c',
  green: '#23d18b',
  yellow: '#e5e510',
  blue: '#3b8eea',
  magenta: '#d670d6',
  cyan: '#29b8db',
  white: '#d4d4d4',
  brightBlack: '#7f7f7f',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};
