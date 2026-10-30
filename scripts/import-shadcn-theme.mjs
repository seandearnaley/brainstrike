#!/usr/bin/env node
/**
 * Turn a shadcn preset code into a Brainstrike theme file.
 *
 *   node scripts/import-shadcn-theme.mjs <preset-code> <theme-id>
 *   node scripts/import-shadcn-theme.mjs <preset-code> <theme-id> \
 *     --from-css <applied-index.css> --decoded <decoded.json> [--out-dir <dir>]
 *
 * Without --from-css the script copies scripts/shadcn-theme-fixture to a temp
 * dir and runs `npx -y shadcn@4.21.0 apply <code> --only theme` there, then
 * `npx -y shadcn@4.21.0 preset decode <code>` for the file header (network).
 * The shadcn version is PINNED: `@latest` would silently re-render every theme
 * the next time upstream changes its palette output.
 *
 * --from-css renders OFFLINE from captures of those two network steps: the
 * applied index.css, plus --decoded, a JSON object of the decode output's
 * key/value lines (it must include `style`). --from-css without --decoded is a
 * usage error, never a silent trip to npx. Use it to re-render a theme from a
 * saved capture. --decoded may also accompany the online path to skip the decode.
 *
 * --out-dir writes the theme file somewhere other than packages/ui/src/themes
 * (the directory must exist), e.g. to diff a re-render against the committed file.
 *
 * Values are never hand-edited: re-run this script to change a theme.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(repoRoot, 'scripts', 'shadcn-theme-fixture');
const THEMES_DIR = path.join(repoRoot, 'packages', 'ui', 'src', 'themes');
const RESERVED_IDS = new Set(['brainstrike']);
const THEME_ID = /^[a-z][a-z0-9-]*$/u;
/** Preset codes are shell arguments to npx; refuse anything but base62. */
const PRESET_CODE = /^[A-Za-z0-9]+$/u;
/** Pinned so a preset re-render is a deliberate, reviewable bump. */
export const SHADCN_VERSION = '4.21.0';

/**
 * The only preset tokens Brainstrike adopts: the 32 colour tokens the theme
 * registry requires (minus `panel-divider`/`panel-surface`, which this script
 * derives) plus `radius`. Anything else a preset emits — `--font-sans`,
 * `--shadow-*`, `--spacing`, … — is a project-wide choice, not a theme, and
 * must fail loudly rather than being silently passed through.
 */
export const ACCEPTED_PRESET_TOKENS = new Set([
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
  'radius',
]);

export function assertPresetCode(code) {
  if (!PRESET_CODE.test(code)) {
    throw new Error(`preset code "${code}" must be alphanumeric (A-Z, a-z, 0-9)`);
  }
}

export function assertThemeId(id) {
  if (!THEME_ID.test(id)) {
    throw new Error(`theme id "${id}" must be a lowercase slug (a-z, 0-9, -)`);
  }
  if (RESERVED_IDS.has(id)) {
    throw new Error(`theme id "${id}" is reserved for the hand-maintained baseline`);
  }
}

/** Reads `selector { --x: value; ... }` into a Map of token name (without --) to value. */
export function extractBlock(css, selector) {
  const pattern = new RegExp(
    `^${selector.replace(/[.[\]]/gu, '\\$&')}\\s*\\{([\\s\\S]*?)^\\}`,
    'mu'
  );
  const match = pattern.exec(css);
  if (!match) {
    throw new Error(`block "${selector}" not found in applied CSS`);
  }
  const tokens = new Map();
  for (const line of match[1].split('\n')) {
    const declaration = /^\s*--([a-z0-9-]+):\s*(.+?);\s*$/u.exec(line);
    if (declaration) {
      tokens.set(declaration[1], declaration[2]);
    }
  }
  return tokens;
}

const DERIVED = {
  dark: [
    ['panel-divider', 'oklch(from var(--bs-background) calc(l + 0.14) c h)'],
    ['panel-surface', 'linear-gradient(to bottom, var(--bs-background), var(--bs-muted))'],
  ],
  light: [
    ['panel-divider', 'oklch(from var(--bs-background) calc(l - 0.12) c h)'],
    ['panel-surface', 'linear-gradient(to bottom, var(--bs-background), var(--bs-muted))'],
  ],
};
const LIGHT_INK = 'oklch(0.985 0 0)';
const DARK_INK = 'oklch(0.145 0 0)';
/** WCAG AA for normal text. */
const MIN_TEXT_CONTRAST = 4.5;
/**
 * Brainstrike paints `primary` and `destructive` both as fills (with their
 * `-foreground` on top) and as text and indicators on the page background
 * (`text-primary` links, `text-destructive` errors). shadcn presets tune them
 * as fills only, so a dark preset primary can sit near 2.4:1 on its background.
 * Each listed colour is moved in lightness (chroma and hue kept) until it reads
 * as text on the background, and each fill gets whichever foreground reads on it.
 */
const TEXT_COLOURS = ['primary', 'destructive'];
const FILL_FOREGROUNDS = [
  ['primary', 'primary-foreground'],
  ['destructive', 'destructive-foreground'],
  ['sidebar-primary', 'sidebar-primary-foreground'],
];

/** Parses `oklch(L C H)` (opaque only); returns null for anything else. */
function parseOklch(value) {
  const match = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/u.exec(value ?? '');
  if (!match) {
    return null;
  }
  const l = Number(match[1]) / (match[2] === '%' ? 100 : 1);
  return { c: Number(match[3]), h: Number(match[4]), l };
}

function formatOklch({ l, c, h }) {
  return `oklch(${Number(l.toFixed(3))} ${c} ${h})`;
}

/** WCAG relative luminance of an OKLCH colour, clipped to the sRGB gamut. */
function luminance({ l, c, h }) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const m_ = (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const s_ = (l - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  const clip = (v) => Math.min(1, Math.max(0, v));
  const r = clip(4.076_741_662_1 * l_ - 3.307_711_591_3 * m_ + 0.230_969_929_2 * s_);
  const g = clip(-1.268_438_004_6 * l_ + 2.609_757_401_1 * m_ - 0.341_319_396_5 * s_);
  const bl = clip(-0.004_196_086_3 * l_ - 0.703_418_614_7 * m_ + 1.707_614_701 * s_);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

export function contrast(first, second) {
  const [hi, lo] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Returns a copy of `tokens` whose text colours read on the background and
 * whose fills carry a readable foreground, plus the names it changed.
 */
export function normalizeContrast(tokens, mode) {
  const next = new Map(tokens);
  const changed = [];
  const background = parseOklch(next.get('background'));
  for (const name of TEXT_COLOURS) {
    let colour = parseOklch(next.get(name));
    if (!(background && colour) || contrast(colour, background) >= MIN_TEXT_CONTRAST) {
      continue;
    }
    const step = mode === 'dark' ? 0.005 : -0.005;
    while (contrast(colour, background) < MIN_TEXT_CONTRAST && colour.l > 0 && colour.l < 1) {
      colour = { ...colour, l: colour.l + step };
    }
    next.set(name, formatOklch(colour));
    changed.push(name);
  }
  for (const [fill, foreground] of FILL_FOREGROUNDS) {
    const fillColour = parseOklch(next.get(fill));
    if (!fillColour) {
      continue;
    }
    const current = parseOklch(next.get(foreground));
    if (current && contrast(current, fillColour) >= MIN_TEXT_CONTRAST) {
      continue;
    }
    const ink =
      contrast(parseOklch(LIGHT_INK), fillColour) >= contrast(parseOklch(DARK_INK), fillColour)
        ? LIGHT_INK
        : DARK_INK;
    if (next.get(foreground) !== ink) {
      next.set(foreground, ink);
      if (current) {
        changed.push(foreground);
      }
    }
  }
  return { changed, tokens: next };
}
/**
 * shadcn's `menuAccent: bold` preset axis paints `accent` with `primary`, so a
 * bold preset ships `--bs-accent === --bs-primary`. Brainstrike does not adopt
 * the menu axes: `bg-accent` is our subtle hover tint and 34 call sites use it
 * without a paired `text-accent-foreground`, so a primary-coloured accent turns
 * every hover into an unreadable brand-on-brand block. Derive the subtle tint
 * instead.
 */
const ACCENT_NORMALIZED_VALUES = [
  ['accent', 'var(--bs-muted)'],
  ['accent-foreground', 'var(--bs-foreground)'],
];

function assertAcceptedTokens(label, tokens) {
  const unexpected = [...tokens.keys()].filter((name) => !ACCEPTED_PRESET_TOKENS.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `preset block "${label}" carries tokens Brainstrike does not adopt: ${unexpected.join(', ')}`
    );
  }
}

/**
 * Returns a copy of `tokens` with a bold menu accent replaced by the derived
 * subtle tint, plus whether the substitution happened.
 */
function normalizeAccent(tokens) {
  const accent = tokens.get('accent');
  const primary = tokens.get('primary');
  if (accent === undefined || primary === undefined || accent !== primary) {
    return { normalized: false, tokens };
  }
  const next = new Map(tokens);
  for (const [name, value] of ACCENT_NORMALIZED_VALUES) {
    next.set(name, value);
  }
  return { normalized: true, tokens: next };
}

function renderBlock(selector, tokens, derived) {
  const lines = [];
  for (const [name, value] of tokens) {
    lines.push(`  --bs-${name}: ${value};`);
  }
  for (const [name, value] of derived) {
    lines.push(`  --bs-${name}: ${value};`);
  }
  return `${selector} {\n${lines.join('\n')}\n}\n`;
}

export function renderThemeCss({ id, code, decoded, light, dark }) {
  assertThemeId(id);
  assertPresetCode(code);
  assertAcceptedTokens(':root', light);
  assertAcceptedTokens('.dark', dark);
  const lightAccent = normalizeAccent(light);
  const darkAccent = normalizeAccent(dark);
  const accentNormalized = lightAccent.normalized || darkAccent.normalized;
  const lightContrast = normalizeContrast(lightAccent.tokens, 'light');
  const darkContrast = normalizeContrast(darkAccent.tokens, 'dark');
  const contrastChanges = [
    ...lightContrast.changed.map((name) => `${name} (light)`),
    ...darkContrast.changed.map((name) => `${name} (dark)`),
  ];
  const decodedLines = Object.entries(decoded)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ` *   ${key.padEnd(12)}${value}`)
    .join('\n');
  const accentNote = accentNormalized
    ? ` *
 *   accentNormalized: true — preset menuAccent is a menu axis Brainstrike does
 *   not adopt; accent normalized to the subtle tint.
`
    : '';
  const contrastNote =
    contrastChanges.length > 0
      ? ` *
 *   contrastAdjusted: moved to WCAG AA (4.5:1) because Brainstrike also uses
 *   primary and destructive as text on the background, and every fill needs
 *   a readable foreground:
${contrastChanges.map((change) => ` *     ${change}`).join('\n')}
`
      : '';
  const header = `/*
 * Theme "${id}" — GENERATED from shadcn preset ${code}. Do not hand-edit values.
 * Regenerate: node scripts/import-shadcn-theme.mjs ${code} ${id}
 *             (pins npx -y shadcn@${SHADCN_VERSION})
 * Preview:    https://ui.shadcn.com/create?preset=${code}
 *
 * Decoded preset:
${decodedLines}
${accentNote}${contrastNote} *
 * Only the colour palette and radius are adopted. Style, fonts and icons are
 * project-wide choices and are not part of a theme. Semantic status tokens
 * (success/warning/info) and the font hooks inherit from themes/brainstrike.css.
 */
`;
  return `${header}${renderBlock(
    `:root[data-theme="${id}"]`,
    lightContrast.tokens,
    DERIVED.light
  )}\n${renderBlock(`:root[data-theme="${id}"].dark`, darkContrast.tokens, DERIVED.dark)}`;
}

function decodePreset(code) {
  assertPresetCode(code);
  const output = execFileSync('npx', ['-y', `shadcn@${SHADCN_VERSION}`, 'preset', 'decode', code], {
    encoding: 'utf8',
  });
  const decoded = {};
  for (const line of output.split('\n')) {
    const match = /^\s{2}([a-zA-Z]+)\s{2,}(\S+)\s*$/u.exec(line);
    if (match && match[1] !== 'code' && match[1] !== 'version' && match[1] !== 'url') {
      decoded[match[1]] = match[2];
    }
  }
  if (!decoded.style) {
    throw new Error(`could not decode preset "${code}":\n${output}`);
  }
  return decoded;
}

function applyPreset(code) {
  assertPresetCode(code);
  const tmp = mkdtempSync(path.join(tmpdir(), 'shadcn-theme-'));
  try {
    cpSync(FIXTURE_DIR, tmp, { recursive: true });
    execFileSync(
      'npx',
      ['-y', `shadcn@${SHADCN_VERSION}`, 'apply', code, '--only', 'theme', '-y'],
      { cwd: tmp, stdio: 'inherit' }
    );
    return readFileSync(path.join(tmp, 'src', 'index.css'), 'utf8');
  } finally {
    rmSync(tmp, { force: true, recursive: true });
  }
}

function usageError(message) {
  console.error(message);
  process.exit(1);
}

/** The value after `flag` in `args`, or null when the flag is absent. */
function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) {
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    usageError(`usage: ${flag} requires a value`);
  }
  return value;
}

/**
 * Reads a captured `shadcn preset decode` result: a JSON object whose values
 * are all strings and which includes `style` (the same sanity check
 * `decodePreset` applies to the live output). Anything else is refused rather
 * than rendered into a truncated header.
 */
function readDecoded(file) {
  let decoded;
  try {
    decoded = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    throw new Error(`--decoded ${file} could not be read as JSON: ${error.message}`);
  }
  const valid =
    decoded !== null &&
    typeof decoded === 'object' &&
    !Array.isArray(decoded) &&
    typeof decoded.style === 'string' &&
    Object.values(decoded).every((value) => typeof value === 'string');
  if (!valid) {
    throw new Error(
      `--decoded ${file} must be a JSON object of string values that includes "style" (the decode output's key/value lines)`
    );
  }
  return decoded;
}

function main(argv) {
  const [code, id, ...rest] = argv;
  if (!(code && id)) {
    usageError(
      'usage: node scripts/import-shadcn-theme.mjs <preset-code> <theme-id> [--from-css <file> --decoded <file>] [--out-dir <dir>]'
    );
  }
  assertThemeId(id);
  assertPresetCode(code);
  const fromCssPath = flagValue(rest, '--from-css');
  const decodedPath = flagValue(rest, '--decoded');
  const outDir = path.resolve(flagValue(rest, '--out-dir') ?? THEMES_DIR);
  if (fromCssPath && !decodedPath) {
    usageError(
      '--from-css renders offline, so it also needs --decoded <file> (the decode output as JSON); refusing to decode the preset through npx'
    );
  }
  const applied = fromCssPath ? readFileSync(path.resolve(fromCssPath), 'utf8') : applyPreset(code);
  const decoded = decodedPath ? readDecoded(decodedPath) : decodePreset(code);
  const light = extractBlock(applied, ':root');
  const dark = extractBlock(applied, '.dark');
  const css = renderThemeCss({ code, dark, decoded, id, light });
  const target = path.join(outDir, `${id}.css`);
  writeFileSync(target, css);
  console.log(`wrote ${path.relative(repoRoot, target)}`);
  console.log('Registry entry (packages/ui/src/themes/index.ts):');
  console.log(
    JSON.stringify(
      {
        id,
        label: id.charAt(0).toUpperCase() + id.slice(1),
        presetCode: code,
        swatch: {
          dark: { background: dark.get('background'), primary: dark.get('primary') },
          light: { background: light.get('background'), primary: light.get('primary') },
        },
      },
      null,
      2
    )
  );
  console.log(
    'Then add `@import "./' +
      id +
      '.css";` to packages/ui/src/themes/index.css and its entry to packages/ui/src/themes/index.ts.'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
