// Inter font files are exported as static assets
// The actual font files are in the inter/ directory

export const INTER_FONT_PATHS = {
  variable: '/fonts/inter/InterVariable.ttf',
  variableItalic: '/fonts/inter/InterVariable-Italic.ttf',
} as const;

export type InterFontPath = (typeof INTER_FONT_PATHS)[keyof typeof INTER_FONT_PATHS];

/**
 * Generate CSS font-face declarations for Inter font
 * @param basePath - Base path for font files (defaults to standard public path)
 */
export function generateInterFontFaces(basePath = '/fonts/inter'): string {
  return `
@font-face {
  font-family: "Inter";
  src: url("${basePath}/InterVariable.ttf") format("truetype");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: "Inter";
  src: url("${basePath}/InterVariable-Italic.ttf") format("truetype");
  font-weight: 100 900;
  font-style: italic;
  font-display: swap;
}`.trim();
}

/**
 * Font family CSS declaration for use in CSS-in-JS or Tailwind
 */
export const INTER_FONT_FAMILY =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif';

/**
 * Available font files in the Inter package
 */
export const INTER_FONT_FILES = ['InterVariable.ttf', 'InterVariable-Italic.ttf'] as const;
