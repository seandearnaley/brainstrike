#!/usr/bin/env node
/**
 * Turn a shadcn preset code into a Brainstrike theme file.
 *
 *   node scripts/import-shadcn-theme.mjs <preset-code> <theme-id> [--from-css <applied-index.css>]
 *
 * Without --from-css the script copies scripts/shadcn-theme-fixture to a temp
 * dir and runs `npx -y shadcn@4.21.0 apply <code> --only theme` there (network).
 * The shadcn version is PINNED: `@latest` would silently re-render every theme
 * the next time upstream changes its palette output.
 * With --from-css it renders from an already-applied index.css, which skips the
 * `apply` step only — decoding the preset for the file header still shells out
 * to npx. Used by the tests and for capturing fixtures. Values are never
 * hand-edited: re-run this script to change a theme.
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
const DESTRUCTIVE_FOREGROUND_FALLBACK = 'oklch(0.985 0 0)';
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
  if (!tokens.has('destructive-foreground')) {
    lines.push(`  --bs-destructive-foreground: ${DESTRUCTIVE_FOREGROUND_FALLBACK};`);
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
  const header = `/*
 * Theme "${id}" — GENERATED from shadcn preset ${code}. Do not hand-edit values.
 * Regenerate: node scripts/import-shadcn-theme.mjs ${code} ${id}
 *             (pins npx -y shadcn@${SHADCN_VERSION})
 * Preview:    https://ui.shadcn.com/create?preset=${code}
 *
 * Decoded preset:
${decodedLines}
${accentNote} *
 * Only the colour palette and radius are adopted. Style, fonts and icons are
 * project-wide choices and are not part of a theme. Semantic status tokens
 * (success/warning/info) and the font hooks inherit from themes/brainstrike.css.
 */
`;
  return `${header}${renderBlock(
    `:root[data-theme="${id}"]`,
    lightAccent.tokens,
    DERIVED.light
  )}\n${renderBlock(`:root[data-theme="${id}"].dark`, darkAccent.tokens, DERIVED.dark)}`;
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

function main(argv) {
  const [code, id, ...rest] = argv;
  if (!(code && id)) {
    console.error(
      'usage: node scripts/import-shadcn-theme.mjs <preset-code> <theme-id> [--from-css <file>]'
    );
    process.exit(1);
  }
  assertThemeId(id);
  assertPresetCode(code);
  const fromCssIndex = rest.indexOf('--from-css');
  const fromCssPath = fromCssIndex >= 0 ? rest[fromCssIndex + 1] : undefined;
  if (fromCssIndex >= 0 && !fromCssPath) {
    console.error('usage: --from-css <applied-index.css> requires a file path');
    process.exit(1);
  }
  const applied = fromCssPath ? readFileSync(path.resolve(fromCssPath), 'utf8') : applyPreset(code);
  const decoded = decodePreset(code);
  const light = extractBlock(applied, ':root');
  const dark = extractBlock(applied, '.dark');
  const css = renderThemeCss({ code, dark, decoded, id, light });
  const target = path.join(THEMES_DIR, `${id}.css`);
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
      '.css";` to packages/ui/src/themes/index.css and the dist copy pair in packages/ui/package.json.'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
