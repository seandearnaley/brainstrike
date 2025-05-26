// Inter font files are exported as static assets
// The actual font files are in the inter/ directory

declare const __dirname: string | undefined;

export function resolveFontPath(relativePath: string): string {
  // Node.js CommonJS environments don't support `import.meta.url`
  // so fall back to __dirname when available.
  if (typeof __dirname !== 'undefined') {
    return `${__dirname}/inter/${relativePath}`;
  }

  return new URL(`./inter/${relativePath}`, import.meta.url).toString();
}

export const INTER_FONT_PATHS = {
  variable: resolveFontPath('InterVariable.ttf'),
  variableItalic: resolveFontPath('InterVariable-Italic.ttf'),
} as const;

export type InterFontPath = (typeof INTER_FONT_PATHS)[keyof typeof INTER_FONT_PATHS];
