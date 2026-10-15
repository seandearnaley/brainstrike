// Composited non-text fill contrast (WCAG 1.4.11, 3:1).
//
// The foreground contract measures a colour utility on its own, which is right
// for text but blind to a fill that paints through `opacity-*`: the browser
// composites it toward whatever is behind it before anyone sees it. A fill that
// measures 4.58:1 as a solid colour is 2.96:1 once 30% of the track shows
// through, so the utility's own number proves nothing about the rendered fill.
//
// This module measures the rendered result instead: for each named fill it
// resolves the colour that actually paints in each theme mode, composites it
// over the real track token at the real opacity, and holds both the solid and
// the composited state to 3:1.
import { composite, contrastRatio, hslToRgb } from './color-contrast.mjs';

/** WCAG 1.4.11 Non-text Contrast. These fills carry meaning but no glyph. */
export const NON_TEXT_MINIMUM = 3;

const DARK_VARIANT = /^dark:/u;
const PALETTE_UTILITY = /^(?:dark:)?text-([a-z]+)-(\d+)$/u;
const SEMANTIC_UTILITY = /^(?:dark:)?text-([a-z][a-z-]*)$/u;
const HSL_TRIPLE = /^-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/u;

/** `30 15% 94%` -> rgb triple, the same parse the surface reader uses. */
export function tokenToRgb(value, label) {
  if (!HSL_TRIPLE.test(value ?? '')) {
    throw new Error(`Missing numeric HSL for ${label}`);
  }
  return hslToRgb(value.replaceAll('%', '').split(/\s+/).map(Number));
}

/**
 * The fraction an `opacity-<n>` utility paints at. Absent or unparseable is an
 * error, never an assumed 1 — a silently assumed opacity would measure the
 * solid colour and reintroduce exactly the blind spot this module exists to
 * close.
 */
export function readOpacity(classes) {
  // Lookarounds, not consumed boundaries: a consumed separator makes
  // `opacity-70 opacity-50` match once and defeats the ambiguity check below.
  const matches = [...classes.matchAll(/(?<![\w-])opacity-(\d{1,3})(?![\w-])/gu)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one opacity-* utility in ${JSON.stringify(classes)}`);
  }
  const percent = Number(matches[0][1]);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error(`opacity-${matches[0][1]} is not a percentage`);
  }
  return percent / 100;
}

/**
 * Which utility in a class string paints in `mode`. A `dark:` variant wins in a
 * dark mode; the bare utility is the light value and the dark fallback.
 */
export function utilityForMode(classes, mode) {
  const utilities = classes.split(/\s+/u).filter((token) => /(?:^|:)text-/u.test(token));
  if (utilities.length === 0) {
    throw new Error(`No text-* colour utility in ${JSON.stringify(classes)}`);
  }
  const dark = mode.includes('dark');
  const variant = utilities.find((utility) => DARK_VARIANT.test(utility));
  const base = utilities.find((utility) => !DARK_VARIANT.test(utility));
  if (dark && variant) {
    return variant;
  }
  if (!base) {
    throw new Error(`No unprefixed colour utility in ${JSON.stringify(classes)}`);
  }
  return base;
}

/**
 * Resolve a colour utility to rgb for one mode. Numbered utilities come from the
 * installed Tailwind palette; a bare name is a semantic token read from that
 * mode's own values, so a high-contrast override is measured rather than
 * assumed. An unrecognised utility throws.
 */
export function resolveUtility(utility, mode, { palette, modes }) {
  const numbered = utility.match(PALETTE_UTILITY);
  if (numbered) {
    const key = `${numbered[1]}-${numbered[2]}`;
    const rgb = palette.get(key);
    if (!rgb) {
      throw new Error(`Unknown palette colour ${key}`);
    }
    return { rgb, source: 'palette' };
  }
  const semantic = utility.match(SEMANTIC_UTILITY);
  if (semantic) {
    const tokens = modes[mode];
    if (!tokens) {
      throw new Error(`Unknown theme mode ${mode}`);
    }
    return {
      rgb: tokenToRgb(tokens.get(`--bs-${semantic[1]}`), `${mode} --bs-${semantic[1]}`),
      source: 'token',
    };
  }
  throw new Error(`Unrecognised colour utility ${utility}`);
}

/**
 * Measure every fill in every mode, in both the solid and composited states.
 * Returns `{ violations, measurements }`; the caller asserts on violations and
 * uses the measurements to prove the audit was not vacuous.
 */
export function auditCompositedFills({ fills, opacity, trackToken, modes, palette }) {
  const violations = [];
  const measurements = [];
  for (const [name, classes] of Object.entries(fills)) {
    for (const mode of Object.keys(modes)) {
      const track = tokenToRgb(modes[mode].get(trackToken), `${mode} ${trackToken}`);
      const utility = utilityForMode(classes, mode);
      const { rgb, source } = resolveUtility(utility, mode, { modes, palette });
      const states = [
        { ratio: contrastRatio(rgb, track), state: 'solid' },
        { ratio: contrastRatio(composite(rgb, track, opacity), track), state: 'composited' },
      ];
      for (const { state, ratio } of states) {
        measurements.push({ mode, name, ratio, source, state, utility });
        if (ratio < NON_TEXT_MINIMUM) {
          violations.push(
            `${name} ${utility} on ${mode} ${trackToken.replace('--bs-', '')} ` +
              `${state}: ${ratio.toFixed(2)}:1; need ${NON_TEXT_MINIMUM}:1` +
              (state === 'composited' ? ` at opacity ${opacity}` : '')
          );
        }
      }
    }
  }
  return { measurements, violations };
}
