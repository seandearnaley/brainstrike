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
