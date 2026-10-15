// Shared Vitest alias registry: resolve every `@brainstrike/*` workspace import
// to package SOURCE instead of built `dist`.
//
// WHY THIS EXISTS (incident #1066 / #1207): a package test lane that imports a
// workspace package with NO `resolve.alias` entry resolves that specifier via
// the package's `exports` map to its BUILT dist. When the dist was stale (or
// the emit silently broke), the test kept passing against old code and push-CI
// stayed red for ~3 weeks unnoticed. apps/web and apps/desktop already carry
// large hand-maintained `@brainstrike/* -> src` alias maps; the individual
// package vitest configs did not. This module is the single source of truth so
// every package test lane genuinely executes SOURCE.
//
// It is a plain `.mjs` (no build step) loaded directly by vitest `.mts` configs
// via the package.json `./workspace-src-aliases` export pointing at this file.
//
// DESIGN (exact aliases only — no blanket directory prefixes):
// - package root  -> regex-EXACT alias (`/^@brainstrike\/pkg$/`) to the root
//   export's source file;
// - each exported code subpath -> regex-EXACT alias to its source file, derived
//   from the package's own `exports` map (so renamed entries like
//   `embeddings/backend` -> `src/backend-entry.ts` resolve correctly);
// - a wildcard export (`./*`) -> a narrow string PREFIX alias, permitted ONLY
//   when the wildcard maps same-name into `dist` (so `pkg/foo` == `src/foo`);
// - EVERY emitted target is existence-validated at generation time — a missing
//   source file throws (NO SILENT FALLBACKS);
// - asset exports (`.css`, `.json`, `icons`), src-pointing exports, and
//   prebuilt `*.worker` bundles get NO alias — they keep resolving through the
//   `exports` map;
// - UNLISTED subpaths are NOT captured: they fall through to node resolution so
//   an unexported import fails loudly instead of silently landing somewhere.
//
// USAGE (config-local overrides WIN — vitest `resolve.alias` is first-match, so
// put deliberate mocks / dist pins / dedicated helpers BEFORE the spread):
//
//   import { workspaceSrcAliases } from '@brainstrike/test-utils/workspace-src-aliases';
//   resolve: {
//     alias: [
//       { find: '@brainstrike/embeddings', replacement: '.../__mocks__/embeddings.ts' },
//       ...workspaceSrcAliases(resolve(import.meta.dirname, '..')),
//     ],
//   }
//
// NOTE on @brainstrike/workers: it has no `src/` dir (worker files live at the
// package root), so the registry skips it; consumers alias its subpaths
// explicitly (e.g. `@brainstrike/workers/file-content-worker` ->
// `../workers/file-content-worker.ts`).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Packages that must NOT be blanket source-aliased. Excludable/overridable via
// the `exclude` option; these are the always-on defaults with their reason.
export const DEFAULT_SRC_ALIAS_EXCLUSIONS = Object.freeze([
  // Verification-only package: application packages must never gain an
  // undeclared source-resolution path into the MCP lab.
  '@brainstrike/mcp-test-lab',
  // @brainstrike/agent's root + most subpaths pull Mastra / Node-only deps that
  // cannot load in a browser/happy-dom test. Consumers that need agent code use
  // the curated `createAgentBrowserSafeAliasEntries` helper
  // (packages/agent/config/browser-safe-subpath-aliases.mjs — browser-safe
  // subpaths only), placed as a local override before this spread. A config
  // WITHOUT that helper that runtime-imports agent falls through to node
  // resolution (dist) — the workspace-src-alias guard
  // (scripts/verify-workspace-src-aliases.mjs) flags exactly that case.
  '@brainstrike/agent',
]);

const SRC_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs'];
const CODE_EXT_RE = /\.(d\.ts|d\.mts|d\.cts|mjs|cjs|js|tsx|ts)$/;

/** Escape a specifier for embedding in a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

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
  if (typeof name !== 'string' || !name.startsWith('@brainstrike/') || exclude.has(name)) {
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

/** Regex-exact alias for a validated source file. */
function exactEntry(specifier, file) {
  return { find: new RegExp(`^${escapeRegExp(specifier)}$`), replacement: file };
}

/**
 * Handle a wildcard export key. Permitted ONLY when the wildcard maps
 * same-name into dist code (`./*` -> `./dist/*.js`), which makes a narrow
 * string prefix (`@brainstrike/pkg` -> `pkg/src`) faithful. Any other
 * dist-code wildcard shape throws (no silent fallback); asset/src wildcards
 * (e.g. `./tsconfig/*.json`, `./icons/*`) are skipped.
 */
function wildcardEntry({ name, srcDir }, key, target) {
  const t = typeof target === 'string' ? target.replace(/^\.\//, '') : null;
  if (t === null || !t.startsWith('dist/') || !CODE_EXT_RE.test(t)) {
    return null; // asset / src-pointing wildcard: exports map handles it
  }
  const keyBody = key.replace(/^\.\//, ''); // e.g. `*` or `stores/*`
  const targetStem = t.slice('dist/'.length).replace(CODE_EXT_RE, ''); // e.g. `*`
  if (keyBody !== targetStem) {
    throw new Error(
      `workspaceSrcAliases: ${name} wildcard export '${key}' -> '${target}' is not a ` +
        'same-name-into-src mapping; add explicit handling instead of a blanket prefix'
    );
  }
  const nsDir = keyBody === '*' ? srcDir : join(srcDir, keyBody.slice(0, -2));
  if (!existsSync(nsDir)) {
    throw new Error(
      `workspaceSrcAliases: ${name} wildcard export '${key}' has no source dir at ${nsDir}`
    );
  }
  const prefix = keyBody === '*' ? name : `${name}/${keyBody.slice(0, -2)}`;
  return { find: prefix, replacement: nsDir };
}

/** Build alias entries for one workspace package: {exact: [], prefix: []}. */
function packageAliasEntries(workspacePkg) {
  const { name, srcDir, exportsMap } = workspacePkg;
  const exact = [];
  const prefix = [];

  for (const [key, value] of Object.entries(exportsMap)) {
    if (key.includes('*')) {
      const wildcard = wildcardEntry(workspacePkg, key, pickTarget(value));
      if (wildcard) {
        prefix.push(wildcard);
      }
      continue;
    }
    const stem = distTargetToStem(pickTarget(value));
    // Non-dist-code exports (css/json assets, src-pointing files like
    // test-utils' vitest.setup / vitest.base) keep resolving via `exports`.
    if (!stem) {
      continue;
    }
    // Prebuilt worker bundles (`*.worker`) are loaded as-is by worker-URL /
    // bundle consumers; they keep resolving to dist via `exports`.
    if (/\.worker$/.test(stem)) {
      continue;
    }
    const file = resolveSrcFile(srcDir, stem);
    if (!file) {
      throw new Error(
        `workspaceSrcAliases: ${name} export '${key}' has no source file for stem '${stem}' under ${srcDir}`
      );
    }
    exact.push(exactEntry(key === '.' ? name : `${name}/${key.replace(/^\.\//, '')}`, file));
  }

  // Package with no exports map (or none aliasable) but an importable source
  // root: emit the bare-specifier alias so the root import executes source.
  if (exact.length === 0 && prefix.length === 0) {
    const indexFile = resolveSrcFile(srcDir, 'index');
    if (indexFile) {
      exact.push(exactEntry(name, indexFile));
    }
  }
  return { exact, prefix };
}

/**
 * Build Vitest-compatible `resolve.alias` entries mapping every `@brainstrike/*`
 * workspace package root AND its exported code subpaths to source.
 *
 * @param {string} packagesDir Absolute path to the monorepo `packages/` dir
 *   (typically `resolve(import.meta.dirname, '..')` from a package config).
 * @param {{ exclude?: string[] }} [options] Additional package names to skip.
 *   Config-local aliases placed BEFORE the spread already override the registry
 *   (first-match wins); `exclude` is for the rarer case of dropping an entry
 *   entirely.
 * @returns {{ find: string | RegExp, replacement: string }[]}
 */
export function workspaceSrcAliases(packagesDir, options = {}) {
  if (!(packagesDir && existsSync(packagesDir))) {
    throw new Error(`workspaceSrcAliases: packagesDir does not exist: ${String(packagesDir)}`);
  }
  const exclude = new Set([...DEFAULT_SRC_ALIAS_EXCLUSIONS, ...(options.exclude ?? [])]);
  const exactEntries = [];
  const prefixEntries = [];

  for (const dirName of readdirSync(packagesDir)) {
    const workspacePkg = readWorkspacePackage(packagesDir, dirName, exclude);
    if (!workspacePkg) {
      continue;
    }
    const { exact, prefix } = packageAliasEntries(workspacePkg);
    exactEntries.push(...exact);
    prefixEntries.push(...prefix);
  }

  // Exact (anchored regex) entries first, then the few wildcard prefixes, so an
  // explicit subpath export always wins over a wildcard namespace (first-match).
  return [...exactEntries, ...prefixEntries];
}

/**
 * Simulate Vite/Vitest's first-match `resolve.alias` resolution for one
 * specifier against an alias entry list (this registry's output, or a
 * config's full array including local overrides placed before the spread).
 * Returns the resolved target path, or null when nothing matches (the
 * specifier falls through to normal node/package `exports` resolution).
 *
 * Shared here (not duplicated per consumer) because both
 * `scripts/verify-workspace-src-aliases.mjs` (the guard) and
 * `apps/*\/src/__tests__/vite-config.test.ts` (behavioral alias-contract
 * tests, Series C R6 task 5) need the exact same simulation — and app test
 * files cannot reach into `scripts/` directly (it sits outside their
 * tsconfig project's `rootDir`).
 *
 * @param {string} specifier
 * @param {{ find: string | RegExp, replacement: string }[]} aliasEntries
 * @returns {string | null}
 */
export function resolveThroughAliases(specifier, aliasEntries) {
  for (const { find, replacement } of aliasEntries) {
    if (typeof find === 'string') {
      if (specifier === find || specifier.startsWith(`${find}/`)) {
        return `${replacement}${specifier.slice(find.length)}`;
      }
    } else if (find instanceof RegExp && find.test(specifier)) {
      return specifier.replace(find, replacement);
    }
  }
  return null;
}
