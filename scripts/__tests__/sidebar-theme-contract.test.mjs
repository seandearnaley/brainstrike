import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
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

/** Every component that could mount a sidebar-tokened utility. */
const CALL_SITE_GLOBS = ['packages/*/src/**/*.tsx', 'apps/*/src/**/*.tsx'];

/**
 * Utility prefixes that resolve against the `--color-*` namespace. Ordered
 * longest-first so side-scoped forms (`border-b-`) win over their base
 * (`border-`) — `border-b-sidebar-border` is a real utility that sets
 * border-bottom-color, and matching it as `border-` would leave the nonsense
 * token `b-sidebar-border`.
 */
const COLOR_UTILITY_PREFIXES = [
  'border-x-',
  'border-y-',
  'border-t-',
  'border-r-',
  'border-b-',
  'border-l-',
  'border-s-',
  'border-e-',
  'divide-x-',
  'divide-y-',
  'ring-offset-',
  'ring-',
  'bg-',
  'text-',
  'border-',
  'divide-',
  'from-',
  'via-',
  'to-',
  'fill-',
  'stroke-',
  'outline-',
  'shadow-',
  'accent-',
  'caret-',
  'decoration-',
  'placeholder-',
];

/** Anything word-ish containing a lowercase `sidebar`, with variants and opacity. */
const SIDEBAR_CANDIDATE = /[\w-]+(?::[\w-]+)*[\w-]*sidebar[\w-]*(?:\/\d+)?/g;

/** Returned when a match is not a `--color-*` utility at all. */
const NOT_A_COLOR_UTILITY = Symbol('not-a-color-utility');

/**
 * Reduces a utility class as written in JSX (`hover:border-sidebar-ring/40`) to
 * the theme token it reads (`sidebar-ring`), after dropping variants and any
 * opacity suffix. Returns NOT_A_COLOR_UTILITY for matches that never reach a
 * colour prefix — import paths (`../navigation-sidebar`), identifiers
 * (`sidebarOpen`), data attributes (`data-sidebar-state`).
 *
 * The token is returned verbatim, including nonsense: deciding whether it is a
 * real sidebar token is the caller's job, so an unrecognised shape cannot be
 * mistaken for "not a sidebar utility" and silently dropped.
 */
function tokenForUtility(utilityClass) {
  const base = utilityClass.split(':').at(-1).split('/')[0];
  const prefix = COLOR_UTILITY_PREFIXES.find((candidate) => base.startsWith(candidate));
  return prefix ? base.slice(prefix.length) : NOT_A_COLOR_UTILITY;
}

/**
 * Collects the sidebar colour utilities in one file.
 *
 * NO SILENT FALLBACKS: a match that reaches a colour prefix but does not yield a
 * `sidebar`/`sidebar-*` token means this parser does not understand a class that
 * really is a sidebar utility. Dropping it would let an unmapped token render no
 * CSS while this suite stayed green — precisely the failure the suite exists to
 * catch — so it throws instead.
 */
function sidebarUtilitiesIn(source, path) {
  const found = [];
  for (const candidate of new Set(source.match(SIDEBAR_CANDIDATE) ?? [])) {
    const token = tokenForUtility(candidate);
    if (token === NOT_A_COLOR_UTILITY) {
      continue;
    }
    if (token !== 'sidebar' && !token.startsWith('sidebar-')) {
      throw new Error(
        `${path}: cannot resolve "${candidate}" to a theme token (parsed "${token}"). ` +
          'It reaches a --color-* utility prefix and contains "sidebar", so it is a sidebar ' +
          'colour utility whose prefix is missing from COLOR_UTILITY_PREFIXES. Add it there — ' +
          'skipping it would let an unmapped token emit no CSS while this suite stayed green.'
      );
    }
    found.push({ candidate, path, token });
  }
  return found;
}

function collectSidebarUtilities() {
  return CALL_SITE_GLOBS.flatMap((pattern) =>
    globSync(pattern, { cwd: REPOSITORY_ROOT }).flatMap((path) =>
      sidebarUtilitiesIn(read(path), path)
    )
  );
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

  it('backs every sidebar utility used in any component with a registered token', () => {
    const used = collectSidebarUtilities();
    assert.ok(
      used.length > 0,
      `expected to find sidebar utilities under ${CALL_SITE_GLOBS.join(', ')}; an empty scan means the globs stopped matching, not that the app is clean`
    );

    for (const { candidate, path, token } of used) {
      assert.ok(
        SIDEBAR_TOKENS.includes(token),
        `${path}: "${candidate}" reads --color-${token}, which is not a declared sidebar token`
      );
      // Redundant by construction — the assertion above plus the registration
      // test already cover this, and with a stricter regex. Kept only because it
      // names the offending class and file, which those two cannot.
      for (const [themePath, theme] of APP_THEMES) {
        assert.ok(
          theme.includes(`--color-${token}:`),
          `${path}: "${candidate}" is mounted in the app but ${themePath} defines no --color-${token}`
        );
      }
    }
  });

  it('resolves side-scoped colour utilities instead of mangling them', () => {
    assert.equal(tokenForUtility('border-b-sidebar-border'), 'sidebar-border');
    assert.equal(tokenForUtility('hover:border-t-sidebar-ring/40'), 'sidebar-ring');
    assert.equal(tokenForUtility('focus-visible:ring-offset-sidebar'), 'sidebar');
    assert.equal(tokenForUtility('../navigation-sidebar'), NOT_A_COLOR_UTILITY);
  });

  it('throws instead of skipping a sidebar utility it cannot parse', () => {
    assert.throws(
      () => sidebarUtilitiesIn('<div className="bg-gradient-sidebar-primary" />', 'fake.tsx'),
      (error) =>
        error instanceof Error &&
        error.message.includes('bg-gradient-sidebar-primary') &&
        error.message.includes('fake.tsx'),
      'an unparseable sidebar colour utility must fail loudly, naming the class and its file'
    );
  });
});
