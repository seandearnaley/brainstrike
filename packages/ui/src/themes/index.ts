/**
 * Palette registry. One entry per file in this directory (parity is pinned by
 * theme-registry.test.ts). Add a theme with scripts/import-shadcn-theme.mjs,
 * then append its entry here.
 */
export type ThemeId = 'brainstrike' | 'ember' | 'tide' | 'orchid';

export interface ThemeSwatch {
  readonly background: string;
  readonly primary: string;
}

export interface ThemeDefinition {
  readonly id: ThemeId;
  readonly label: string;
  /** shadcn preset code the file was generated from; null for the hand-maintained baseline. */
  readonly presetCode: string | null;
  readonly swatch: { readonly dark: ThemeSwatch; readonly light: ThemeSwatch };
}

export const DEFAULT_THEME: ThemeId = 'brainstrike';

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'brainstrike',
    label: 'Brainstrike',
    presetCode: null,
    swatch: {
      dark: { background: 'hsl(30 8% 9%)', primary: 'hsl(215 50% 58%)' },
      light: { background: 'hsl(30 25% 99%)', primary: 'hsl(215 55% 45%)' },
    },
  },
  {
    id: 'ember',
    label: 'Ember',
    presetCode: 'buKEvLs',
    swatch: {
      dark: { background: 'oklch(0.145 0 0)', primary: 'oklch(0.444 0.177 26.899)' },
      light: { background: 'oklch(1 0 0)', primary: 'oklch(0.505 0.213 27.518)' },
    },
  },
  {
    id: 'tide',
    label: 'Tide',
    presetCode: 'bNRM0gzE1',
    swatch: {
      dark: { background: 'oklch(0.148 0.004 228.8)', primary: 'oklch(0.45 0.085 224.283)' },
      light: { background: 'oklch(1 0 0)', primary: 'oklch(0.52 0.105 223.128)' },
    },
  },
  {
    id: 'orchid',
    label: 'Orchid',
    presetCode: 'b4aRK71bRz',
    swatch: {
      dark: { background: 'oklch(0.145 0.008 326)', primary: 'oklch(0.459 0.187 3.815)' },
      light: { background: 'oklch(1 0 0)', primary: 'oklch(0.525 0.223 3.958)' },
    },
  },
];

const THEME_IDS: ReadonlySet<string> = new Set(THEMES.map((theme) => theme.id));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEME_IDS.has(value);
}
