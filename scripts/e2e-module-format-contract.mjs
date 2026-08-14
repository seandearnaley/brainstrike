// Static contract for the Playwright E2E graphs under apps/*/e2e.
//
// Playwright picks a module format per file from the nearest package.json `type`
// (playwright/lib/transform/esmLoader.js):
//
//     isRequire ? 'commonjs'
//               : fileIsModule(filename) ? 'module' : 'commonjs'
//
// The app manifests (apps/desktop, apps/web) are deliberately CommonJS — Electron
// main, electron-builder and the vite configs depend on that — so without an ESM
// manifest inside e2e/, every spec is CommonJS and every ESM-only workspace
// library it reaches gets force-transpiled to CommonJS by babel. Two things break
// when that happens, and BST-1217 hit both:
//
//   * `import.meta` has no CommonJS representation, so the transpiled module dies
//     with `SyntaxError: Cannot use 'import.meta' outside a module` — this took
//     out desktop spec COLLECTION entirely (0 tests in 0 files).
//   * `export *` becomes a runtime `Object.keys(...).forEach` getter loop that
//     cjs-module-lexer cannot see through, so a STATIC named import of a
//     re-exported binding fails to link (`does not provide an export named X`).
//     A dynamic import() of the same module still works, which is why this
//     surfaced as a selective, confusing failure.
//   * A relative import that escapes an E2E root is CommonJS-transpiled. If that
//     target statically imports an ESM-only package, Node loads the package
//     through require() and can fail before Playwright discovers any tests.
//
// This module is a LIBRARY of pure predicates. It runs as a gate only via
// scripts/__tests__/e2e-module-format-contract.test.mjs (`pnpm test:scripts`,
// which is part of the PR-required Static job). The tests exercise both the real
// tree and synthetic inputs, so the instrument is proven able to fail.
//
// See docs/agents/ci-quality.md and BST-1217.

import fs from 'node:fs';
import path from 'node:path';

/** Extensions Playwright will load from an E2E directory. */
const SPEC_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx'];

/** Directories that never contain first-party spec sources. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'blob-report',
  'test-results',
  'playwright-report',
]);

/**
 * Whole-`..`-segment containment check (BST-1256): a bare `startsWith('..')`
 * misreads in-tree names like "..fixtures" as an escape. Mirrors the canonical
 * `isPathInsideRoot` in `@brainstrike/file-system/path-validation` (kept
 * inline because this guard runs standalone, before any package build).
 */
function isInsideRoot(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate);
  return (
    relative === '' ||
    !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  );
}

/**
 * Walks up from `startDirectory` to `stopDirectory` (inclusive) and returns the
 * first package.json found. Mirrors Playwright's `fileIsModule` lookup.
 */
export function findNearestPackageJson(startDirectory, stopDirectory) {
  let current = path.resolve(startDirectory);
  const stop = path.resolve(stopDirectory);

  for (;;) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    if (current === stop) {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** True when a manifest declares ESM, using Playwright's exact test. */
export function manifestDeclaresEsm(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).type === 'module';
  } catch {
    return false;
  }
}

/** Recursively lists loadable source files under `directory`. */
export function listSourceFiles(directory) {
  const found = [];

  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(path.join(current, entry.name));
        }
        continue;
      }
      if (SPEC_EXTENSIONS.includes(path.extname(entry.name))) {
        found.push(path.join(current, entry.name));
      }
    }
  };

  walk(directory);
  return found;
}

/** Every apps/<app>/e2e directory that actually holds spec sources. */
export function findE2eRoots(repoRoot) {
  const appsDirectory = path.join(repoRoot, 'apps');
  if (!fs.existsSync(appsDirectory)) {
    return [];
  }

  const roots = [];
  for (const entry of fs.readdirSync(appsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const e2eDirectory = path.join(appsDirectory, entry.name, 'e2e');
    if (!fs.existsSync(e2eDirectory)) {
      continue;
    }
    if (listSourceFiles(e2eDirectory).some((file) => file.includes('.test.'))) {
      roots.push(e2eDirectory);
    }
  }
  return roots;
}

/**
 * Blanks line and block comments, and optionally the contents of string and
 * template literals, so the scanners below cannot be fooled by prose or by an
 * example written inside a string. Removed spans become spaces, so offsets and
 * line numbers stay intact.
 */
function blankSpans(source, { includeStrings }) {
  let output = '';
  let index = 0;

  const blank = (length) => ' '.repeat(length);

  while (index < source.length) {
    const two = source.slice(index, index + 2);

    if (two === '//') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      output += blank(stop - index);
      index = stop;
      continue;
    }

    if (two === '/*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      output += blank(stop - index);
      index = stop;
      continue;
    }

    const character = source[index];
    if (includeStrings && (character === '"' || character === "'" || character === '`')) {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (source[cursor] === character) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      output += blank(cursor - index);
      index = cursor;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

/** Blanks comments only — keeps string literals, so specifiers stay readable. */
export function stripComments(source) {
  return blankSpans(source, { includeStrings: false });
}

/** Blanks comments and string/template literals. */
export function stripCommentsAndStrings(source) {
  return blankSpans(source, { includeStrings: true });
}

/** `export * from '...'` / `export * as ns from '...'` — invisible to cjs-module-lexer. */
export function hasStarReexport(source) {
  return /(^|[\s;}])export\s+\*/.test(stripCommentsAndStrings(source));
}

/** Top-level `import.meta` — unrepresentable once transpiled to CommonJS. */
export function hasImportMeta(source) {
  return /(^|[^.\w$])import\s*\.\s*meta\b/.test(stripCommentsAndStrings(source));
}

/**
 * Runtime static import/export specifiers; statement-level type-only edges
 * disappear during transpilation. Inline type modifiers are conservatively
 * retained so the contract may inspect an extra file but cannot miss a runtime
 * edge.
 */
export function extractRuntimeStaticSpecifiers(source) {
  const cleaned = stripComments(source);
  const specifiers = new Set();
  const pattern =
    /(?:^|[\s;}])(?:import(?!\s+type\b)|export(?!\s+type\b))(?:\s[^;'"]*?from)?\s*['"]([^'"]+)['"]/g;

  let match = pattern.exec(cleaned);
  while (match !== null) {
    specifiers.add(match[1]);
    match = pattern.exec(cleaned);
  }

  return [...specifiers];
}

/** Resolves a relative specifier to an on-disk source file, or null. */
export function resolveRelativeSpecifier(importerFile, specifier) {
  const base = path.resolve(path.dirname(importerFile), specifier);
  const candidates = [
    base,
    ...SPEC_EXTENSIONS.map((extension) => `${base}${extension}`),
    // TS `.js`-specifier convention.
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.mts'),
    ...SPEC_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Rule A — every apps/*&#47;e2e graph must be ESM.
 * Returns a list of human-readable violations (empty when the contract holds).
 */
export function findModuleFormatViolations(repoRoot) {
  const violations = [];

  for (const e2eRoot of findE2eRoots(repoRoot)) {
    const manifestPath = findNearestPackageJson(e2eRoot, repoRoot);
    const relativeRoot = path.relative(repoRoot, e2eRoot);

    if (!manifestPath) {
      violations.push(`${relativeRoot}: no package.json found walking up to the repo root.`);
      continue;
    }
    if (!manifestDeclaresEsm(manifestPath)) {
      violations.push(
        `${relativeRoot}: nearest manifest ${path.relative(repoRoot, manifestPath)} does not declare "type": "module", ` +
          'so Playwright will transpile these specs — and every ESM-only workspace library they reach — to CommonJS.'
      );
    }
  }

  return violations;
}

/** Playwright's own config-resolution set: playwright.config.{m,c}?{js,ts}. */
const PLAYWRIGHT_CONFIG_NAMES = [
  'playwright.config.mts',
  'playwright.config.mjs',
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.cts',
  'playwright.config.cjs',
];

/** Locates the Playwright config that governs an e2e root (it sits in the app dir). */
export function findPlaywrightConfig(e2eRoot) {
  const appDirectory = path.dirname(e2eRoot);
  for (const name of PLAYWRIGHT_CONFIG_NAMES) {
    const candidate = path.join(appDirectory, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Rule C — the config shares the process with the specs, so it must share their
 * module format.
 *
 * A CommonJS config that imports a workspace library pulls that library into the
 * run through `require`, which makes Playwright emit a CommonJS transform for it.
 * When a spec later does a STATIC named import of the same library from the ESM
 * graph, the two formats collide and the import fails to link. That is exactly
 * how apps/web broke: playwright.config.ts imported `parsePositiveIntegerConfig`
 * from @brainstrike/platform-utils, and every spec reaching platform-utils then
 * died with `does not provide an export named 'getContentSecurityPolicy'` —
 * removing only that one config import made the whole web suite collect again.
 *
 * Naming the config `.mts` makes it ESM by extension regardless of the app
 * manifest, so the whole process is one format. Requiring it here means nobody
 * has to remember which libraries a CommonJS config is allowed to touch.
 */
export function findConfigFormatViolations(repoRoot) {
  const violations = [];

  for (const e2eRoot of findE2eRoots(repoRoot)) {
    const rootManifest = findNearestPackageJson(e2eRoot, repoRoot);
    if (!(rootManifest && manifestDeclaresEsm(rootManifest))) {
      continue; // Rule A already reports this.
    }

    const configPath = findPlaywrightConfig(e2eRoot);
    if (!configPath) {
      violations.push(
        `${path.relative(repoRoot, e2eRoot)}: no playwright.config.* found beside the e2e directory.`
      );
      continue;
    }

    const configIsEsm =
      configPath.endsWith('.mts') ||
      configPath.endsWith('.mjs') ||
      (!(configPath.endsWith('.cts') || configPath.endsWith('.cjs')) &&
        manifestDeclaresEsm(findNearestPackageJson(path.dirname(configPath), repoRoot) ?? ''));

    if (!configIsEsm) {
      violations.push(
        `${path.relative(repoRoot, configPath)} is CommonJS while ${path.relative(repoRoot, e2eRoot)} is ESM. ` +
          'A CommonJS config that imports a workspace library forces a CommonJS transform of it, ' +
          'which then fails to link when a spec statically imports the same library. Rename the config to .mts.'
      );
    }
  }

  return violations;
}

/**
 * Rule B — a relative import that escapes an e2e root lands under the app's own
 * CommonJS manifest, so Playwright transpiles it even though its importer is ESM.
 * That is tolerable only while every CommonJS-transpiled module reachable from
 * the target avoids static bare-package imports, exposes named exports in a
 * form cjs-module-lexer can read, and contains no `import.meta`.
 */
export function findEscapingImportViolations(repoRoot) {
  const violations = [];
  const e2eRoots = findE2eRoots(repoRoot);

  for (const e2eRoot of e2eRoots) {
    const rootManifest = findNearestPackageJson(e2eRoot, repoRoot);
    if (!(rootManifest && manifestDeclaresEsm(rootManifest))) {
      // Rule A already reports this; do not double-report.
      continue;
    }

    for (const file of listSourceFiles(e2eRoot)) {
      const source = fs.readFileSync(file, 'utf8');

      for (const specifier of extractRuntimeStaticSpecifiers(source).filter((candidate) =>
        candidate.startsWith('.')
      )) {
        const resolved = resolveRelativeSpecifier(file, specifier);
        if (!resolved) {
          continue;
        }
        if (isInsideRoot(e2eRoot, resolved)) {
          continue; // stays inside the ESM root
        }

        const targetManifest = findNearestPackageJson(path.dirname(resolved), repoRoot);
        if (targetManifest && manifestDeclaresEsm(targetManifest)) {
          continue; // escapes into another ESM manifest — fine
        }

        const importer = path.relative(repoRoot, file);
        const boundaryTarget = path.relative(repoRoot, resolved);
        const pending = [resolved];
        const visited = new Set();

        while (pending.length > 0) {
          const current = pending.shift();
          if (!current || visited.has(current)) {
            continue;
          }
          visited.add(current);

          if (e2eRoots.some((root) => isInsideRoot(root, current))) {
            continue;
          }

          const currentManifest = findNearestPackageJson(path.dirname(current), repoRoot);
          if (currentManifest && manifestDeclaresEsm(currentManifest)) {
            continue;
          }

          const currentSource = fs.readFileSync(current, 'utf8');
          const currentTarget = path.relative(repoRoot, current);
          const runtimeSpecifiers = extractRuntimeStaticSpecifiers(currentSource);
          const runtimeDependencies = runtimeSpecifiers.filter(
            (candidate) => !candidate.startsWith('.')
          );
          if (runtimeDependencies.length > 0) {
            violations.push(
              `${importer} imports '${specifier}' (${boundaryTarget}), whose CommonJS-transpiled runtime graph ` +
                `reaches ${currentTarget} with runtime bare dependencies (${runtimeDependencies.join(', ')}) — ` +
                'keep bare package imports out of an escaping boundary so CommonJS cannot require an ESM-only package.'
            );
          }

          if (hasImportMeta(currentSource)) {
            violations.push(
              `${importer} imports '${specifier}' (${boundaryTarget}), whose CommonJS-transpiled runtime graph ` +
                `reaches ${currentTarget} using import.meta — that cannot be represented in CommonJS and will throw at load.`
            );
          }
          if (hasStarReexport(currentSource)) {
            violations.push(
              `${importer} imports '${specifier}' (${boundaryTarget}), whose CommonJS-transpiled runtime graph ` +
                `reaches ${currentTarget} using \`export *\` — cjs-module-lexer cannot see through the transpiled ` +
                'getter loop, so static named imports will fail to link.'
            );
          }

          for (const relativeSpecifier of runtimeSpecifiers.filter((candidate) =>
            candidate.startsWith('.')
          )) {
            const next = resolveRelativeSpecifier(current, relativeSpecifier);
            if (next && !visited.has(next)) {
              pending.push(next);
            }
          }
        }
      }
    }
  }

  return violations;
}
