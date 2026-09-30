import { composite, contrastRatio, oklchToRgb } from './color-contrast.mjs';

const FAMILIES =
  '(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe)';

/** Parse the installed Tailwind palette, so an upgrade cannot keep stale numbers. */
export function parsePalette(css) {
  const colors = new Map();
  const pattern = /--color-([a-z]+-\d+):\s*oklch\(\s*([\d.]+)(%)?\s+([\d.]+)\s+([\d.]+|none)\s*\)/g;
  for (const [, name, lightness, percent, chroma, hue] of css.matchAll(pattern)) {
    colors.set(
      name,
      oklchToRgb([
        Number(lightness) / (percent ? 100 : 1),
        Number(chroma),
        hue === 'none' ? 0 : Number(hue),
      ])
    );
  }
  if (colors.size === 0) {
    throw new Error('No OKLCH palette entries found');
  }
  return colors;
}

/**
 * Input is one static class string, not arbitrary source. Runtime-built classes,
 * arbitrary values, ancestor opacity and unknown backgrounds require browser QA.
 * Background/border palette utilities are intentionally outside foreground policy.
 */
export function readUtilityColors(text) {
  const pattern = new RegExp(`^(?:(.+):)?!?text-(${FAMILIES}-\\d+)(?:/([^!]+))?!?$`);
  return text.split(/\s+/).flatMap((utility) => {
    const match = utility.match(pattern);
    if (!match) {
      return [];
    }
    const modifier = match[3];
    const opacity =
      modifier === undefined
        ? 1
        : /^\d+(?:\.\d+)?$/.test(modifier)
          ? Number(modifier) / 100
          : /^\[(?:\d*\.)?\d+%?\]$/.test(modifier)
            ? Number(modifier.slice(1, -1).replace('%', '')) / (modifier.includes('%') ? 100 : 1)
            : null;
    return [
      {
        color: match[2],
        dark: (match[1] ?? '').split(':').includes('dark'),
        opacity,
        utility,
        warning: /^(?:amber|yellow)-/.test(match[2]),
      },
    ];
  });
}

/** Conservative light-theme evaluation: the WORST ratio across all surfaces wins. */
export function collectForegroundViolations({
  text,
  palette,
  surfaces,
  minimum = 4.5,
  preferSemantic = true,
}) {
  const entries = Object.entries(surfaces);
  if (entries.length === 0) {
    throw new Error('At least one measured surface is required');
  }
  return readUtilityColors(text).flatMap((paint) => {
    const semantic = preferSemantic && paint.warning;
    if (paint.dark) {
      return semantic
        ? [{ ...paint, minimum, preferSemantic: true, ratio: null, surface: 'dark-only' }]
        : [];
    }
    const rgb = palette.get(paint.color);
    if (!rgb) {
      throw new Error(`Missing palette entry: ${paint.color}`);
    }
    if (paint.opacity === null) {
      throw new Error(
        `Unsupported foreground opacity: ${paint.utility}; use a measured semantic foreground and check its rendered opacity`
      );
    }
    if (paint.opacity < 0 || paint.opacity > 1) {
      throw new Error(`Invalid foreground opacity: ${paint.utility}`);
    }
    const measurements = entries
      .map(([surface, background]) => ({
        ratio: contrastRatio(composite(rgb, background, paint.opacity), background),
        surface,
      }))
      .sort((left, right) => left.ratio - right.ratio);
    const worst = measurements[0];
    return worst.ratio < minimum || semantic
      ? [{ ...paint, ...worst, minimum, preferSemantic: semantic }]
      : [];
  });
}
