import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..');

const read = (relativePath) => readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');

const SHARED_THEME = read('packages/ui/src/globals.css');
const APP_THEMES = [
  ['apps/web/src/app/globals.css', read('apps/web/src/app/globals.css')],
  ['apps/desktop/src/renderer/styles.css', read('apps/desktop/src/renderer/styles.css')],
];

/**
 * Every `--sidebar*` alias declared in the shared palette. A Tailwind v4 utility
 * only emits CSS when its token has a `--color-<name>` entry in the consuming
 * app's `@theme` block, so each alias needs a matching entry in BOTH apps.
 */
const SIDEBAR_TOKENS = [
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
];

/** Files that mount sidebar-tokened utilities in the running app. */
const CALL_SITES = [
  'packages/ui/src/navigation-sidebar.tsx',
  'packages/app-shell/src/account-menu.tsx',
];

/** Utility prefixes that resolve against the `--color-*` namespace, longest first. */
const COLOR_UTILITY_PREFIXES = [
  'ring-offset-',
  'ring-',
  'bg-',
  'text-',
  'border-',
  'from-',
  'via-',
  'to-',
  'fill-',
  'stroke-',
  'divide-',
  'outline-',
  'shadow-',
  'accent-',
  'caret-',
  'decoration-',
];

/**
 * Reduces a utility class as written in JSX (`hover:border-sidebar-ring/40`) to
 * the theme token it reads (`sidebar-ring`). Returns undefined when the class is
 * not a sidebar color utility.
 */
function tokenForUtility(utilityClass) {
  // Drop variants (`hover:`, `focus-visible:`, `before:`) and any opacity suffix.
  const base = utilityClass.split(':').at(-1)?.split('/')[0];
  if (!base) {
    return '';
  }
  const prefix = COLOR_UTILITY_PREFIXES.find((candidate) => base.startsWith(candidate));
  if (!prefix) {
    return '';
  }
  const token = base.slice(prefix.length);
  return token === 'sidebar' || token.startsWith('sidebar-') ? token : '';
}

function sidebarUtilitiesIn(source) {
  const matches = source.match(/[\w-]+(?::[\w-]+)*(?::)?[\w-]*sidebar[\w-]*(?:\/\d+)?/g) ?? [];
  return [...new Set(matches.filter((candidate) => tokenForUtility(candidate)))];
}

describe('sidebar theme contract', () => {
  it('declares every --sidebar alias in the shared palette', () => {
    for (const token of SIDEBAR_TOKENS) {
      assert.match(
        SHARED_THEME,
        new RegExp(`--${token}:\\s*var\\(--bs-${token}\\);`),
        `packages/ui/src/globals.css must alias --${token} to --bs-${token}`
      );
    }
  });

  it('registers every --sidebar alias as a --color-* token in both apps', () => {
    for (const [path, theme] of APP_THEMES) {
      for (const token of SIDEBAR_TOKENS) {
        assert.match(
          theme,
          new RegExp(`--color-${token}:\\s*hsl\\(var\\(--${token}\\)\\);`),
          `${path} @theme must define --color-${token}; without it every ${token} utility silently emits no CSS`
        );
      }
    }
  });

  it('backs every sidebar utility used in the app with a registered token', () => {
    const used = CALL_SITES.flatMap((path) => sidebarUtilitiesIn(read(path)));
    assert.ok(used.length > 0, 'expected sidebar utilities at the known call sites');

    for (const utilityClass of new Set(used)) {
      const token = tokenForUtility(utilityClass);
      assert.ok(
        SIDEBAR_TOKENS.includes(token),
        `"${utilityClass}" reads --color-${token}, which is not a declared sidebar token`
      );
      for (const [path, theme] of APP_THEMES) {
        assert.ok(
          theme.includes(`--color-${token}:`),
          `"${utilityClass}" is mounted in the app but ${path} defines no --color-${token}`
        );
      }
    }
  });
});
