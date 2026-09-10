#!/usr/bin/env node
/**
 * Turn a shadcn preset code into a Brainstrike theme file.
 *
 *   node scripts/import-shadcn-theme.mjs <preset-code> <theme-id> [--from-css <applied-index.css>]
 *
 * Without --from-css the script copies scripts/shadcn-theme-fixture to a temp
 * dir and runs `npx shadcn@latest apply <code> --only theme` there (network).
 * With --from-css it renders from an already-applied index.css (offline; used
 * by the tests and for capturing fixtures). Values are never hand-edited:
 * re-run this script to change a theme.
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
    ['panel-divider', 'oklch(from var(--bs-border) calc(l + 0.06) c h)'],
    ['panel-surface', 'linear-gradient(to bottom, var(--bs-background), var(--bs-muted))'],
  ],
  light: [
    ['panel-divider', 'oklch(from var(--bs-border) calc(l - 0.06) c h)'],
    ['panel-surface', 'linear-gradient(to bottom, var(--bs-background), var(--bs-muted))'],
  ],
};
const DESTRUCTIVE_FOREGROUND_FALLBACK = 'oklch(0.985 0 0)';

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
  const decodedLines = Object.entries(decoded)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ` *   ${key.padEnd(12)}${value}`)
    .join('\n');
  const header = `/*
 * Theme "${id}" — GENERATED from shadcn preset ${code}. Do not hand-edit values.
 * Regenerate: node scripts/import-shadcn-theme.mjs ${code} ${id}
 * Preview:    https://ui.shadcn.com/create?preset=${code}
 *
 * Decoded preset:
${decodedLines}
 *
 * Only the colour palette and radius are adopted. Style, fonts and icons are
 * project-wide choices and are not part of a theme. Semantic status tokens
 * (success/warning/info) and the font hooks inherit from themes/brainstrike.css.
 */
`;
  return `${header}${renderBlock(`:root[data-theme="${id}"]`, light, DERIVED.light)}\n${renderBlock(
    `:root[data-theme="${id}"].dark`,
    dark,
    DERIVED.dark
  )}`;
}

function decodePreset(code) {
  const output = execFileSync('npx', ['-y', 'shadcn@latest', 'preset', 'decode', code], {
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
  const tmp = mkdtempSync(path.join(tmpdir(), 'shadcn-theme-'));
  try {
    cpSync(FIXTURE_DIR, tmp, { recursive: true });
    execFileSync('npx', ['-y', 'shadcn@latest', 'apply', code, '--only', 'theme', '-y'], {
      cwd: tmp,
      stdio: 'inherit',
    });
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
  const fromCssIndex = rest.indexOf('--from-css');
  const applied =
    fromCssIndex >= 0
      ? readFileSync(path.resolve(rest[fromCssIndex + 1]), 'utf8')
      : applyPreset(code);
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
