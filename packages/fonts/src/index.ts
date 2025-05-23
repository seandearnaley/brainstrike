// Inter font files are exported as static assets
// The actual font files are in the inter/ directory

export const INTER_FONT_PATHS = {
  variable: '/fonts/inter/InterVariable.ttf',
  variableItalic: '/fonts/inter/InterVariable-Italic.ttf',
} as const;

export type InterFontPath = (typeof INTER_FONT_PATHS)[keyof typeof INTER_FONT_PATHS];
