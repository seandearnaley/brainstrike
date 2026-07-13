// Shared Vitest alias registry: resolve every `@brainstrike/*` workspace import
// to package SOURCE instead of built `dist`.
//
// WHY THIS EXISTS (incident #1066 / #1207): a package test lane that imports a
// workspace package with NO `resolve.alias` entry resolves that specifier via
// the package's `exports` map to its BUILT `dist`. When the dist was stale (or
// the emit silently broke), the test kept passing against old code and push-CI
// stayed red for ~3 weeks unnoticed. apps/web and apps/desktop already carry
// large hand-maintained `@brainstrike/* -> src` alias maps; the individual
// package vitest configs did not. This module is the single source of truth so
// every package test lane genuinely executes SOURCE.
//
// It is a plain `.mjs` (no build step) loaded directly by vitest `.mts` configs
// via the package.json `./workspace-src-aliases` export pointing at this file.
//
// USAGE (config-local overrides WIN — vitest `resolve.alias` is first-match, so
// put deliberate mocks / dist pins / dedicated helpers BEFORE the spread):
//
//   import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
//   resolve: {
//     alias: [
//       { find: '@brainstrike/storage', replacement: '.../storage/__mocks__' },
//       ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
//     ],
//   }
//
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Packages that must NOT be blanket source-aliased. Excludable/overridable via
// the `exclude` option; these are the always-on defaults with their reason.
export const DEFAULT_SRC_ALIAS_EXCLUSIONS = Object.freeze([
  // @brainstrike/agent's root + most subpaths pull Mastra / Node-only deps that
  // cannot load in a browser/happy-dom test. Consumers that need agent code use
  // the curated `createAgentBrowserSafeAliasEntries` helper (browser-safe
  // subpaths only), placed as a local override before this spread.
  '@brainstrike/agent',
]);

// Packages that get ONLY a regex-exact root alias (`/^<name>$/` -> src/index),
// never a directory prefix. @brainstrike/test-utils is this registry's own home:
// its `vitest.base`/`workspace-src-aliases` exports are root-level `.mjs` files
// (NOT under src/) and `vitest.setup` points at `src/vitest.setup.ts` directly.
// A blanket `-> src` PREFIX would rewrite `@brainstrike/test-utils/vitest.base`
// to a nonexistent `src/vitest.base`; a regex-exact root alias only rewrites the
// bare specifier (the test helpers), leaving those subpaths to package exports.
const ROOT_EXACT_ONLY_PACKAGES = Object.freeze(['@brainstrike/test-utils']);

const SRC_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

const CODE_EXT_RE = /\.(d\.ts|d\.mts|d\.cts|mjs|cjs|js|tsx|ts)$/;

/**
 * Strip a `dist/`-backed export target down to its path stem, or return null
 * when the target is not a built code module worth source-aliasing (a
 * src-pointing export, a `.json`/`.css` asset, or a wildcard pattern).
 * `./dist/backend-entry.d.ts` -> `backend-entry`
 * `./dist/utils/embedding-models.js` -> `utils/embedding-models`
 * `./dist/context-actions/index.d.ts` -> `context-actions/index`
 * `./biome/biome.json` -> null   (asset, not built code)
 * `./src/vitest-browser.ts` -> null   (already resolves to source)
 */
function distTargetToStem(target) {
  if (typeof target !== 'string' || target.includes('*')) {
    return null;
  }
  const t = target.replace(/^\.\//, '');
  if (!(t.startsWith('dist/') && CODE_EXT_RE.test(t))) {
    return null;
  }
  return t.slice('dist/'.length).replace(CODE_EXT_RE, '');
}

/** Pick the representative target string from an exports condition value. */
function pickTarget(conditionValue) {
  if (typeof conditionValue === 'string') {
    return conditionValue;
  }
  if (conditionValue && typeof conditionValue === 'object') {
    // Prefer a RUNTIME condition: it names the actual module file, whereas
    // `types` is often a shared `index.d.ts` that would mis-derive the stem
    // (e.g. test-utils' `electron`/`worker` exports both point `types` at
    // `dist/index.d.ts`). `types` is only a last resort.
    return (
      conditionValue.import ??
      conditionValue.require ??
      conditionValue.default ??
      conditionValue.types ??
      null
    );
  }
  return null;
}

/** Resolve a stem to an existing source file under `srcDir`, or null. */
function resolveSrcFile(srcDir, stem) {
  for (const ext of SRC_EXTENSIONS) {
    const candidate = join(srcDir, `${stem}${ext}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  for (const ext of SRC_EXTENSIONS) {
    const candidate = join(srcDir, stem, `index${ext}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Read a workspace `package.json`, returning its identity or null to skip. */
function readWorkspacePackage(packagesDir, dirName, exclude) {
  const pkgDir = join(packagesDir, dirName);
  if (!statSync(pkgDir).isDirectory()) {
    return null;
  }
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return null;
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const name = pkg.name;
  if (
    typeof name !== 'string' ||
    !name.startsWith('@brainstrike/') ||
    exclude.has(name) ||
    ROOT_EXACT_ONLY_PACKAGES.includes(name)
  ) {
    return null;
  }
  const srcDir = join(pkgDir, 'src');
  // Packages without a `src/` dir (e.g. @brainstrike/workers, whose files live
  // at the package root) are consumed via bespoke config-local aliases, not
  // this registry.
  if (!existsSync(srcDir)) {
    return null;
  }
  return { exportsMap: pkg.exports ?? {}, name, srcDir };
}

/**
 * Alias entries for a package ROOT.
 * `@brainstrike/<pkg>` -> `<pkg>/src` (directory prefix) covers the bare import
 * AND every same-named subpath (`@brainstrike/<pkg>/foo` -> `<pkg>/src/foo`)
 * because @rollup/plugin-alias only matches a string find on a `/` boundary —
 * sibling names like `file-explorer-ui` are NOT captured by `file-explorer`.
 */
function rootAliasEntries({ name, srcDir, exportsMap }) {
  const entries = { exact: [], prefix: [] };
  const rootStem = distTargetToStem(pickTarget(exportsMap['.']));
  if (rootStem && rootStem !== 'index') {
    // Non-index root export: point the exact specifier at the real source file
    // so the prefix (used for subpaths) can't mis-resolve the bare import.
    const rootFile = resolveSrcFile(srcDir, rootStem);
    if (!rootFile) {
      throw new Error(
        `workspaceSrcAliases: ${name} root export has no source file for stem '${rootStem}' under ${srcDir}`
      );
    }
    entries.exact.push({ find: name, replacement: rootFile });
  }
  // Emit the directory-prefix alias only when the package has an importable
  // source root.
  if (rootStem || resolveSrcFile(srcDir, 'index')) {
    entries.prefix.push({ find: name, replacement: srcDir });
  }
  return entries;
}

/** Exact alias entries for RENAMED subpath exports the root prefix can't cover. */
function subpathAliasEntries({ name, srcDir, exportsMap }) {
  const entries = [];
  for (const [key, value] of Object.entries(exportsMap)) {
    if (key === '.') {
      continue;
    }
    const stem = distTargetToStem(pickTarget(value));
    // Skip non-code assets (css/json), src-pointing exports, wildcard patterns,
    // and prebuilt worker bundles (`*.worker`, loaded as-is by worker consumers).
    if (!stem || /\.worker$/.test(stem)) {
      continue;
    }
    const sub = key.replace(/^\.\//, '');
    // If the directory-prefix root alias already resolves this subpath to the
    // same source file, skip the explicit entry (prefix covers it).
    if (stem === sub || stem === `${sub}/index`) {
      continue;
    }
    const file = resolveSrcFile(srcDir, stem);
    if (!file) {
      throw new Error(
        `workspaceSrcAliases: ${name}${key} export has no source file for stem '${stem}' under ${srcDir}`
      );
    }
    entries.push({ find: `${name}/${sub}`, replacement: file });
  }
  return entries;
}

/** Regex-exact root aliases (`/^<name>$/` -> src/index) for ROOT_EXACT_ONLY pkgs. */
function rootExactOnlyEntries(packagesDir, exclude) {
  const entries = [];
  for (const name of ROOT_EXACT_ONLY_PACKAGES) {
    if (exclude.has(name)) {
      continue;
    }
    const dirName = name.slice('@brainstrike/'.length);
    const srcDir = join(packagesDir, dirName, 'src');
    const indexFile = resolveSrcFile(srcDir, 'index');
    if (!indexFile) {
      throw new Error(
        `workspaceSrcAliases: ${name} has no source index under ${srcDir} (ROOT_EXACT_ONLY)`
      );
    }
    // Regex anchors to the BARE specifier only, so subpath exports
    // (vitest.base/vitest.setup/workspace-src-aliases) are left untouched.
    entries.push({ find: new RegExp(`^${name.replace(/\//g, '\\/')}$`), replacement: indexFile });
  }
  return entries;
}

/**
 * Build Vitest-compatible `resolve.alias` entries mapping every `@brainstrike/*`
 * workspace package root AND its (renamed) subpath exports to source.
 *
 * @param {string} packagesDir Absolute path to the monorepo `packages/` dir
 *   (typically `resolve(import.meta.dirname, '..')` from a package config).
 * @param {{ exclude?: string[] }} [options] Additional package names to skip.
 *   Config-local aliases placed BEFORE the spread already override the registry
 *   (first-match wins); `exclude` is for the rarer case of dropping an entry
 *   entirely.
 * @returns {{ find: string, replacement: string }[]}
 */
export function workspaceSrcAliases(packagesDir, options = {}) {
  if (!(packagesDir && existsSync(packagesDir))) {
    throw new Error(`workspaceSrcAliases: packagesDir does not exist: ${String(packagesDir)}`);
  }
  const exclude = new Set([...DEFAULT_SRC_ALIAS_EXCLUSIONS, ...(options.exclude ?? [])]);
  const rootPrefixEntries = [];
  const subpathEntries = [];

  for (const dirName of readdirSync(packagesDir)) {
    const workspacePkg = readWorkspacePackage(packagesDir, dirName, exclude);
    if (!workspacePkg) {
      continue;
    }
    const root = rootAliasEntries(workspacePkg);
    subpathEntries.push(...root.exact, ...subpathAliasEntries(workspacePkg));
    rootPrefixEntries.push(...root.prefix);
  }

  // Regex-exact roots + subpath (more specific) entries first, then root
  // directory prefixes, so a renamed subpath like `@brainstrike/embeddings/backend`
  // wins over the `@brainstrike/embeddings` prefix (first-match).
  return [...rootExactOnlyEntries(packagesDir, exclude), ...subpathEntries, ...rootPrefixEntries];
}
