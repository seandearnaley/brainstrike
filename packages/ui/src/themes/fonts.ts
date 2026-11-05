/**
 * Font registry. `family` is the whole CSS stack the provider writes to
 * `--font-sans` (interface) or `--font-mono` (code) on <html>; every face named
 * first here is bundled by the desktop app through @fontsource-variable, so a
 * choice never depends on what the user has installed.
 */
export type FontId = 'geist' | 'inter' | 'ibm-plex-sans' | 'system';
export type CodeFontId = 'geist-mono' | 'jetbrains-mono' | 'fira-code' | 'system-mono';

export interface FontDefinition<Id extends string> {
  readonly family: string;
  readonly id: Id;
  readonly label: string;
}

const SANS_FALLBACK = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONO_FALLBACK = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export const DEFAULT_FONT: FontId = 'geist';
export const DEFAULT_CODE_FONT: CodeFontId = 'geist-mono';

export const FONTS: readonly FontDefinition<FontId>[] = [
  { family: `"Geist Variable", ${SANS_FALLBACK}`, id: 'geist', label: 'Geist' },
  { family: `"Inter Variable", ${SANS_FALLBACK}`, id: 'inter', label: 'Inter' },
  {
    family: `"IBM Plex Sans Variable", ${SANS_FALLBACK}`,
    id: 'ibm-plex-sans',
    label: 'IBM Plex Sans',
  },
  { family: SANS_FALLBACK, id: 'system', label: 'System' },
];

export const CODE_FONTS: readonly FontDefinition<CodeFontId>[] = [
  { family: `"Geist Mono Variable", ${MONO_FALLBACK}`, id: 'geist-mono', label: 'Geist Mono' },
  {
    family: `"JetBrains Mono Variable", ${MONO_FALLBACK}`,
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
  },
  { family: `"Fira Code Variable", ${MONO_FALLBACK}`, id: 'fira-code', label: 'Fira Code' },
  { family: MONO_FALLBACK, id: 'system-mono', label: 'System' },
];

const FONT_IDS: ReadonlySet<string> = new Set(FONTS.map((font) => font.id));
const CODE_FONT_IDS: ReadonlySet<string> = new Set(CODE_FONTS.map((font) => font.id));

export function isFontId(value: unknown): value is FontId {
  return typeof value === 'string' && FONT_IDS.has(value);
}

export function isCodeFontId(value: unknown): value is CodeFontId {
  return typeof value === 'string' && CODE_FONT_IDS.has(value);
}

function familyOf<Id extends string>(fonts: readonly FontDefinition<Id>[], id: Id): string {
  const font = fonts.find((definition) => definition.id === id);
  if (!font) {
    throw new Error(`Unknown font: ${id}`);
  }
  return font.family;
}

export function fontFamily(id: FontId): string {
  return familyOf(FONTS, id);
}

export function codeFontFamily(id: CodeFontId): string {
  return familyOf(CODE_FONTS, id);
}

/**
 * Code font sizes in px. Unset means each code surface keeps its own built-in
 * size (13px in the editor, diffs and terminal; a little smaller than the
 * prose in chat); a chosen size applies to all of them.
 */
export const CODE_FONT_SIZES = [11, 12, 13, 14, 15, 16, 18] as const;
export type CodeFontSize = (typeof CODE_FONT_SIZES)[number];
/** What the terminal uses while no size is chosen, matching the editor. */
export const DEFAULT_TERMINAL_FONT_SIZE = 13;

export function isCodeFontSize(value: unknown): value is CodeFontSize {
  return typeof value === 'number' && (CODE_FONT_SIZES as readonly number[]).includes(value);
}

/** Longest custom font name kept; a real family name is far shorter. */
const CUSTOM_FONT_MAX_LENGTH = 64;

/**
 * A font the user typed, reduced to a bare family name: the characters that
 * could end the quoted name or the declaration are dropped, so the value can
 * only ever name a font.
 */
export function cleanCustomFontName(value: string): string {
  return value
    .replace(/["'`;{}\\<>]/gu, '')
    .trim()
    .slice(0, CUSTOM_FONT_MAX_LENGTH);
}

/**
 * A saved custom font is kept as typed, so the field shows what the user
 * wrote; {@link codeFontStack} cleans it each time it is used.
 */
export function isCustomFontName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= CUSTOM_FONT_MAX_LENGTH * 4;
}

/**
 * The whole code font stack: the user's own installed font first when they
 * named one, then the chosen bundled font, so a misspelled or missing custom
 * font still lands on a monospace face.
 */
export function codeFontStack(id: CodeFontId, customFont?: string): string {
  const bundled = codeFontFamily(id);
  const custom = customFont ? cleanCustomFontName(customFont) : '';
  return custom ? `"${custom}", ${bundled}` : bundled;
}
