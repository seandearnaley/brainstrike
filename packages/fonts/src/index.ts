// Font files are exported as static assets
// The actual font files are in their respective directories

declare const __dirname: string | undefined;

function resolveFontPathForDir(dir: string, relativePath: string): string {
  // Node.js CommonJS environments don't support `import.meta.url`
  // so fall back to __dirname when available.
  if (typeof __dirname !== 'undefined') {
    return `${__dirname}/${dir}/${relativePath}`;
  }

  return new URL(`./${dir}/${relativePath}`, import.meta.url).toString();
}

/**
 * @deprecated Use GEIST_FONT_PATHS instead - migrating to Geist for 2025 visual refresh
 */
export function resolveFontPath(relativePath: string): string {
  return resolveFontPathForDir('inter', relativePath);
}

// ============================================================================
// GEIST FONTS (Primary - 2025 Visual Refresh)
// ============================================================================
// Geist is designed by Vercel specifically for developer interfaces.
// Features: Excellent legibility at small sizes, variable font with optical sizing.
// License: SIL Open Font License (OFL-1.1) - free for commercial use.

export const GEIST_FONT_PATHS = {
  /** Geist Sans - Variable font (100-900 weights) */
  sansVariable: resolveFontPathForDir('geist', 'Geist-Variable.ttf'),
  sansVariableWoff2: resolveFontPathForDir('geist', 'Geist-Variable.woff2'),
  /** Geist Mono - Variable font (100-900 weights) with programming ligatures */
  monoVariable: resolveFontPathForDir('geist', 'GeistMono-Variable.ttf'),
  monoVariableWoff2: resolveFontPathForDir('geist', 'GeistMono-Variable.woff2'),
} as const;

export type GeistFontPath = (typeof GEIST_FONT_PATHS)[keyof typeof GEIST_FONT_PATHS];

// ============================================================================
// INTER FONTS (Legacy - being phased out)
// ============================================================================

/**
 * @deprecated Use GEIST_FONT_PATHS instead
 */
export const INTER_FONT_PATHS = {
  variable: resolveFontPathForDir('inter', 'InterVariable.ttf'),
  variableItalic: resolveFontPathForDir('inter', 'InterVariable-Italic.ttf'),
} as const;

export type InterFontPath = (typeof INTER_FONT_PATHS)[keyof typeof INTER_FONT_PATHS];
