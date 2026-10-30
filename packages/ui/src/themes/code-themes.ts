/**
 * Code theme registry: one syntax colour scheme for every code surface. Chat
 * code blocks render the `shiki` pair (light/dark follows the app mode), and
 * CodeMirror surfaces read the matching `--syntax-*` tokens that
 * code-themes.css sets for `data-code-theme`. Add a theme by generating its CSS
 * with scripts/import-code-theme.mjs from the same two Shiki themes, then
 * append its entry here and its imports in shiki/highlighter-core.ts.
 */
export type CodeThemeId = 'classic' | 'github' | 'one' | 'solarized' | 'catppuccin';

export type ShikiThemeName =
  | 'catppuccin-latte'
  | 'catppuccin-mocha'
  | 'github-dark'
  | 'github-light'
  | 'monokai'
  | 'one-dark-pro'
  | 'one-light'
  | 'solarized-dark'
  | 'solarized-light';

export interface CodeThemeDefinition {
  readonly id: CodeThemeId;
  readonly label: string;
  readonly shiki: { readonly dark: ShikiThemeName; readonly light: ShikiThemeName };
}

export const DEFAULT_CODE_THEME: CodeThemeId = 'classic';

export const CODE_THEMES: readonly CodeThemeDefinition[] = [
  { id: 'classic', label: 'Classic', shiki: { dark: 'monokai', light: 'github-light' } },
  { id: 'github', label: 'GitHub', shiki: { dark: 'github-dark', light: 'github-light' } },
  { id: 'one', label: 'One', shiki: { dark: 'one-dark-pro', light: 'one-light' } },
  {
    id: 'solarized',
    label: 'Solarized',
    shiki: { dark: 'solarized-dark', light: 'solarized-light' },
  },
  {
    id: 'catppuccin',
    label: 'Catppuccin',
    shiki: { dark: 'catppuccin-mocha', light: 'catppuccin-latte' },
  },
];

const CODE_THEME_IDS: ReadonlySet<string> = new Set(CODE_THEMES.map((theme) => theme.id));

export function isCodeThemeId(value: unknown): value is CodeThemeId {
  return typeof value === 'string' && CODE_THEME_IDS.has(value);
}

export function codeThemeShikiPair(id: CodeThemeId): CodeThemeDefinition['shiki'] {
  const definition = CODE_THEMES.find((theme) => theme.id === id);
  if (!definition) {
    throw new Error(`Unknown code theme: ${id}`);
  }
  return definition.shiki;
}
