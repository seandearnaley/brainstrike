import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Guard for the defect that broke the Settings modal.
 *
 * Tailwind v4 discovers utilities by scanning source TEXT. A workspace package
 * whose `.tsx` never enters the scan therefore emits NO CSS for any class only
 * it uses — and nothing anywhere reports it. There is no missing import, no
 * type error, no console warning. The classes simply resolve to nothing and the
 * layout silently renders as if they had never been written.
 *
 * `packages/settings-ui` sat in exactly that state: 102 `.tsx` files, no
 * `styles.css` `@source` shim, absent from both app CSS entrypoints. Measured on
 * the running renderer, 103 utilities produced no rule at all — every `sm:`,
 * `md:`, `lg:` and `xl:` variant in Settings (so the panels rendered their
 * narrow branch at every viewport width), `space-y-5` / `space-y-7` (so
 * `CardContent className="p-6 pt-0 space-y-5"` measured 0px between children),
 * the `w-[30%]` / `min-w-[800px]` / `h-[600px]` sizing set, the status color
 * scale, and the provider brand-color custom-property bridge.
 *
 * The convention this enforces: a package that writes Tailwind classes ships a
 * package-local `styles.css` holding `@source "./src"`, exports it as
 * `./styles.css`, and is reachable — directly or through another package's
 * `styles.css` — from EVERY app CSS entrypoint that renders it.
 *
 * Reachability is followed transitively because that is how the repo already
 * wires it: `app-shell/styles.css` re-imports `vector-management` and
 * `notes-vault` rather than every app naming them.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

/** Every app CSS entrypoint that renders shared packages. */
const APP_CSS_ENTRYPOINTS = [
  'apps/web/src/app/globals.css',
  'apps/desktop/src/renderer/styles.css',
];

const WORKSPACE_STYLES_IMPORT = /@import\s+["']@brainstrike\/([\w-]+)\/styles\.css["']/g;

function listTsxFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
        found.push(full);
      }
    }
  };
  if (existsSync(dir)) {
    walk(dir);
  }
  return found;
}

/**
 * Packages that write Tailwind classes into markup. `className=` is the marker
 * rather than "has any `.tsx`" so that hook- and context-only packages do not
 * have to carry a shim they would never use.
 */
function packagesThatWriteClassNames() {
  const names = [];
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const usesClassName = listTsxFiles(join(PACKAGES_DIR, entry.name, 'src')).some((file) =>
      readFileSync(file, 'utf8').includes('className=')
    );
    if (usesClassName) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

/** Follows `@import "@brainstrike/<pkg>/styles.css"` transitively from one entrypoint. */
function packagesReachableFrom(entrypoint) {
  const reached = new Set();
  const queue = [join(REPO_ROOT, entrypoint)];

  while (queue.length > 0) {
    const file = queue.pop();
    if (!existsSync(file)) {
      continue;
    }
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(WORKSPACE_STYLES_IMPORT)) {
      const packageName = match[1];
      if (reached.has(packageName)) {
        continue;
      }
      reached.add(packageName);
      queue.push(join(PACKAGES_DIR, packageName, 'styles.css'));
    }
  }

  return reached;
}

const authors = packagesThatWriteClassNames();

// A floor, not an exact list: this test is worthless if the walker silently
// stops finding anything (a moved `src`, a renamed extension) and every
// assertion below then passes vacuously.
test('the walker finds the packages that write Tailwind classes', () => {
  assert.ok(
    authors.length >= 8,
    `Expected at least 8 class-writing packages, found ${authors.length}: ${authors.join(', ')}`
  );
  assert.ok(authors.includes('settings-ui'));
  assert.ok(authors.includes('ui'));
});

test('every class-writing package ships a styles.css @source shim', () => {
  for (const packageName of authors) {
    const stylesPath = join(PACKAGES_DIR, packageName, 'styles.css');
    assert.ok(
      existsSync(stylesPath),
      `packages/${packageName} writes Tailwind classes but has no styles.css. ` +
        'Create one containing `@source "./src";` and export it as "./styles.css".'
    );
    assert.match(readFileSync(stylesPath, 'utf8'), /@source\s+["']\.\/src["']/);
  }
});

test('every class-writing package exports ./styles.css', () => {
  for (const packageName of authors) {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGES_DIR, packageName, 'package.json'), 'utf8')
    );
    assert.equal(
      manifest.exports?.['./styles.css'],
      './styles.css',
      `packages/${packageName} must expose "./styles.css" in its exports map, or no app can import it.`
    );
  }
});

test('every app CSS entrypoint reaches every class-writing package', () => {
  for (const entrypoint of APP_CSS_ENTRYPOINTS) {
    const reachable = packagesReachableFrom(entrypoint);
    const missing = authors.filter((name) => !reachable.has(name));
    assert.deepEqual(
      missing,
      [],
      `${entrypoint} does not reach ${missing.join(', ')}. Tailwind will emit no CSS for any ` +
        'utility those packages alone use, silently — add an `@import ' +
        '"@brainstrike/<pkg>/styles.css"` there, or chain it from a styles.css that entrypoint ' +
        'already imports.'
    );
  }
});
