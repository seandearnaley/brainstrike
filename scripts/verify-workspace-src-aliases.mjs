// Guard against #1066/#1207 regressions: a package test lane that imports another
// @brainstrike/* workspace package at RUNTIME while the vitest config it runs
// under does not alias that specifier to SOURCE resolves it from BUILT dist
// (via package `exports`). Stale/broken dist then silently passes — the incident
// class.
//
// HOW IT WORKS (no marker strings — the configs are executed):
// 1. Per packages/* with a vitest config, collect every runtime `@brainstrike/*`
//    import SPECIFIER from its source/test files (static `from`, side-effect
//    `import '...'`, and dynamic `import('...')`; type-only imports ignored).
// 2. Enumerate the package's runnable vitest configs. Discovery is the
//    `vitest.*config*.*` filename convention, CROSS-CHECKED against reality:
//    every vitest `--config`/`-c` reference in the package's scripts and every
//    `configFile:` in its stryker config must be in the discovered set — a
//    reference the convention missed throws loudly (checked invariant, not a
//    silent gap). Each config is `import()`ed to get the REAL resolved object,
//    including per-project `resolve.alias` arrays (vitest inline projects do
//    NOT inherit the top-level resolve.alias — see packages/db/vitest.config.mts).
// 3. For each (config, project): close the specifier set to a FIXPOINT over the
//    src-resolved graph — when a specifier resolves into another workspace
//    package's source, that package's own (non-test) runtime specifiers join
//    the set, so transitive chains like embeddings -> embedding-worker(src) ->
//    worker-runtime are checked too. Each specifier is then resolved by
//    simulating vitest's first-match alias order: the winning entry must point
//    at an EXISTING non-dist source path (so a dist-pin override placed before
//    the registry spread FAILS, and so does a stale alias target). If NO alias
//    matches, the specifier falls through to node `exports` resolution — a
//    dist-backed target is a violation.
// 4. Legitimate built-artifact consumers go in WORKSPACE_SRC_ALIAS_ALLOWLIST
//    with a reason string. NO silent fallbacks: anything else fails loudly.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Packages allowed to consume built artifacts from a test lane, keyed by
 * package name. Value: { reason: string, specifiers?: string[] } — when
 * `specifiers` is present only those exact specifiers are exempt; otherwise the
 * whole package is. Keep this list short and justified.
 */
export const WORKSPACE_SRC_ALIAS_ALLOWLIST = Object.freeze({
  // (currently empty — every checked lane resolves workspace imports from src.
  // The TWO B4 dependsOn exceptions are both outside this guard's scope by
  // construction, because neither goes through a workspace import specifier:
  //  - packages/utils logger-dist-singleton.test.ts imports its own dist via a
  //    file URL (intentional built-artifact regression test);
  //  - packages/db __tests__/migration-runner-types.test.ts runs a nested
  //    ts.createProgram whose COMPILER resolution reads @brainstrike/utils
  //    types from dist/index.d.ts — vitest aliases cannot intercept tsc.)
});

const SOURCE_FILE_RE = /\.(ts|tsx|mts|cts)$/;
const VITEST_CONFIG_RE = /^vitest\..*config.*\.(mts|cts|ts|mjs|cjs|js)$/;
const TEST_FILE_RE =
  /\.(test|spec|browser\.test|integration\.test|integration\.spec)\.[cm]?[jt]sx?$/;
const TEST_DIR_NAMES = new Set(['__tests__', 'test', 'tests']);
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', '__mocks__']);
const SRC_RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.js', '.json', '.css'];
const CODE_TARGET_RE = /\.(mjs|cjs|js|jsx|ts|tsx|mts|cts)$/;

/** Recursively collect source files under `dir` (skipping config files). */
function collectSourceFiles(dir, acc, { includeTests }) {
  if (!existsSync(dir)) {
    return acc;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) {
      continue;
    }
    if (!includeTests && entry.isDirectory() && TEST_DIR_NAMES.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, acc, { includeTests });
      continue;
    }
    if (!SOURCE_FILE_RE.test(entry.name) || entry.name.endsWith('.d.ts')) {
      continue;
    }
    if (!includeTests && TEST_FILE_RE.test(entry.name)) {
      continue;
    }
    // Vitest/stryker/playwright config files import config helpers (e.g. the
    // registry itself) at CONFIG time, not at test runtime — exclude them.
    if (/^(vitest|stryker|playwright)\./.test(entry.name) || entry.name.includes('.config.')) {
      continue;
    }
    acc.push(full);
  }
  return acc;
}

const IMPORT_SPECIFIER_RES = [
  /from\s*['"](@brainstrike\/[^'"]+)['"]/, // static import/export ... from
  /^\s*import\s*['"](@brainstrike\/[^'"]+)['"]/, // side-effect import
  /import\s*\(\s*['"](@brainstrike\/[^'"]+)['"]\s*\)/, // dynamic import()
];

/**
 * Full runtime @brainstrike/* specifiers imported by a package (excluding self).
 * `includeTests: false` restricts to non-test sources — used for TRANSITIVE
 * contributions, where only the dep's shipped source (not its own test files)
 * enters the consumer's module graph.
 */
export function collectRuntimeWorkspaceSpecifiers(pkgDir, selfName, options = {}) {
  const includeTests = options.includeTests ?? true;
  const specifiers = new Set();
  for (const file of collectSourceFiles(pkgDir, [], { includeTests })) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      // Type-only imports are erased at compile time — never resolved at runtime.
      if (/^\s*import\s+type\b|^\s*export\s+type\b/.test(line)) {
        continue;
      }
      for (const re of IMPORT_SPECIFIER_RES) {
        const match = line.match(re);
        if (match && match[1].split('/').slice(0, 2).join('/') !== selfName) {
          specifiers.add(match[1]);
        }
      }
    }
  }
  return [...specifiers].sort();
}

/** List runnable vitest config files (base/integration/mutation/models/…). */
export function listRunnableConfigs(pkgDir) {
  return readdirSync(pkgDir)
    .filter((name) => VITEST_CONFIG_RE.test(name) && !name.includes('setup'))
    .sort();
}

/**
 * Cross-check config discovery against how configs are actually referenced:
 * every vitest `--config <path>` / `-c <path>` in package.json scripts and
 * every `configFile: '...'` in a stryker config must name a file the filename
 * convention discovered. A missed reference throws — the convention stays a
 * CHECKED invariant instead of a silent discovery gap.
 */
export function assertConfigDiscoveryComplete(pkgDir, selfName, discoveredConfigs) {
  const discovered = new Set(discoveredConfigs);
  const referenced = new Set();

  const pkgJsonPath = join(pkgDir, 'package.json');
  if (existsSync(pkgJsonPath)) {
    const scripts = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).scripts ?? {};
    for (const command of Object.values(scripts)) {
      if (typeof command !== 'string' || !command.includes('vitest')) {
        continue;
      }
      for (const match of command.matchAll(/(?:--config|-c)[=\s]+(['"]?)([^\s'"]+)\1/g)) {
        referenced.add(match[2]);
      }
    }
  }
  for (const name of readdirSync(pkgDir)) {
    if (!/^stryker\.config\.[cm]?js(on)?$/.test(name)) {
      continue;
    }
    const text = readFileSync(join(pkgDir, name), 'utf8');
    // Lookbehind excludes e.g. stryker's `tsconfigFile:` key.
    for (const match of text.matchAll(/(?<![A-Za-z])configFile['"]?\s*:\s*['"]([^'"]+)['"]/g)) {
      referenced.add(match[1]);
    }
  }

  for (const ref of referenced) {
    const base = ref.split('/').pop();
    if (!discovered.has(base)) {
      throw new Error(
        `workspace-src-alias guard: ${selfName} references vitest config '${ref}' ` +
          '(scripts/stryker) that filename-convention discovery missed — rename it to ' +
          `match vitest.*config*.* or extend the guard's discovery`
      );
    }
  }
}

/** Normalize a vitest alias value (array or object map) to ordered entries. */
function normalizeAliasEntries(alias) {
  if (!alias) {
    return [];
  }
  if (Array.isArray(alias)) {
    return alias.filter((entry) => entry && entry.find !== undefined);
  }
  return Object.entries(alias).map(([find, replacement]) => ({ find, replacement }));
}

/**
 * Import a vitest config module and return its effective projects:
 * `[{ label, aliasEntries }]`. Inline `test.projects` do NOT inherit the
 * top-level `resolve.alias`, so each project contributes ONLY its own aliases.
 */
export async function loadConfigProjects(configPath) {
  const mod = await import(pathToFileURL(configPath).href);
  const cfg = mod.default;
  if (!cfg || typeof cfg !== 'object') {
    throw new Error(`workspace-src-alias guard: ${configPath} has no default-export config`);
  }
  const projects = cfg.test?.projects;
  if (Array.isArray(projects)) {
    return projects
      .filter((project) => project && typeof project === 'object')
      .map((project, index) => ({
        aliasEntries: normalizeAliasEntries(project.resolve?.alias),
        label: project.test?.name ?? `project#${index}`,
      }));
  }
  return [{ aliasEntries: normalizeAliasEntries(cfg.resolve?.alias), label: 'root' }];
}

/** Simulate vitest first-match alias resolution. Returns target path or null. */
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

/** True if an alias target resolves to an existing file/dir (vite-style). */
function aliasTargetExists(target) {
  if (existsSync(target)) {
    return true;
  }
  for (const ext of SRC_RESOLVE_EXTENSIONS) {
    if (existsSync(`${target}${ext}`) || existsSync(join(target, `index${ext}`))) {
      return true;
    }
  }
  return false;
}

function pickExportTarget(conditionValue) {
  if (typeof conditionValue === 'string') {
    return conditionValue;
  }
  if (conditionValue && typeof conditionValue === 'object') {
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

/** Match a subpath against a package `exports` map (exact key, then wildcard). */
function exportsTargetFor(exportsMap, subpath) {
  if (typeof exportsMap === 'string') {
    return subpath === '.' ? exportsMap : null;
  }
  if (!exportsMap || typeof exportsMap !== 'object') {
    return null;
  }
  const direct = exportsMap[subpath];
  if (direct !== undefined) {
    return pickExportTarget(direct);
  }
  for (const [key, value] of Object.entries(exportsMap)) {
    const star = key.indexOf('*');
    if (star === -1) {
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      const target = pickExportTarget(value);
      return typeof target === 'string'
        ? target.replace('*', subpath.slice(prefix.length, subpath.length - suffix.length))
        : null;
    }
  }
  return null;
}

/** Build the package-name -> package-dir index for a packages root. */
function indexWorkspacePackages(packagesRoot) {
  const index = new Map();
  for (const dirName of readdirSync(packagesRoot)) {
    const pkgDir = join(packagesRoot, dirName);
    if (!statSync(pkgDir).isDirectory()) {
      continue;
    }
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      continue;
    }
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name.startsWith('@brainstrike/')) {
      index.set(pkg.name, { dir: pkgDir, pkg });
    }
  }
  return index;
}

/** Find the workspace package whose directory contains `path`, or null. */
function owningWorkspacePackage(path, packageIndex) {
  for (const [name, { dir }] of packageIndex) {
    if (path === dir || path.startsWith(`${dir}/`)) {
      return name;
    }
  }
  return null;
}

/**
 * Resolve one specifier under a project's aliases.
 * Returns { problem } for a violation, or { targetPath } for a healthy
 * resolution (targetPath is the absolute source path when it lands inside the
 * workspace — used for the transitive fixpoint — or null when out of scope).
 */
function resolveSpecifier(specifier, aliasEntries, packageIndex) {
  const aliased = resolveThroughAliases(specifier, aliasEntries);
  if (aliased !== null) {
    if (/(^|\/)dist(\/|$)/.test(aliased)) {
      return { problem: `alias resolves to built dist: ${aliased}` };
    }
    if (!aliasTargetExists(aliased)) {
      return { problem: `alias target does not exist: ${aliased}` };
    }
    return { targetPath: aliased };
  }
  // Fall-through: node `exports` resolution.
  const depName = specifier.split('/').slice(0, 2).join('/');
  const dep = packageIndex.get(depName);
  if (!dep) {
    return { targetPath: null }; // non-workspace — outside this guard's scope
  }
  const subpath = specifier === depName ? '.' : `./${specifier.slice(depName.length + 1)}`;
  const target =
    exportsTargetFor(dep.pkg.exports, subpath) ??
    (subpath === '.' ? (dep.pkg.module ?? dep.pkg.main ?? null) : null);
  if (target === null) {
    return { targetPath: null }; // unexported: node resolution fails LOUDLY
  }
  if (/^\.\/?dist\//.test(target)) {
    return {
      problem: `falls through to built dist via exports: ${depName} ${subpath} -> ${target}`,
    };
  }
  // exports points at a source file (e.g. test-utils' vitest.setup) or an
  // asset (css/json). Only code targets feed the transitive fixpoint.
  return { targetPath: CODE_TARGET_RE.test(target) ? join(dep.dir, target) : null };
}

/**
 * Check one (config, project): close the owning package's specifier set to a
 * fixpoint over src-resolved workspace edges, resolving each specifier as we
 * go. Transitive violations carry the referral chain in `problem`.
 */
function checkProject({
  selfName,
  seedSpecifiers,
  aliasEntries,
  packageIndex,
  transitiveSpecifiersFor,
  isAllowed,
}) {
  const problems = [];
  const queue = seedSpecifiers.map((specifier) => ({ specifier, via: [] }));
  const seen = new Set(seedSpecifiers);

  while (queue.length > 0) {
    const { specifier, via } = queue.shift();
    const { problem, targetPath } = resolveSpecifier(specifier, aliasEntries, packageIndex);
    if (problem) {
      problems.push({
        problem: via.length > 0 ? `${problem} (via ${via.join(' -> ')})` : problem,
        specifier,
      });
      continue;
    }
    if (!targetPath) {
      continue;
    }
    const owner = owningWorkspacePackage(targetPath, packageIndex);
    if (!owner || owner === selfName) {
      continue;
    }
    for (const transitive of transitiveSpecifiersFor(owner)) {
      if (seen.has(transitive) || isAllowed(transitive)) {
        continue;
      }
      seen.add(transitive);
      queue.push({ specifier: transitive, via: [...via, `${specifier} [${owner} src]`] });
    }
  }
  return problems;
}

/**
 * Scan `packagesRoot` and return violations:
 * `{ package, config, project, specifier, problem }[]`.
 */
export async function findWorkspaceSrcAliasViolations(options = {}) {
  const packagesRoot = options.packagesRoot ?? resolve(HERE, '..', 'packages');
  const allowlist = options.allowlist ?? WORKSPACE_SRC_ALIAS_ALLOWLIST;
  for (const [name, entry] of Object.entries(allowlist)) {
    if (typeof entry?.reason !== 'string' || entry.reason.length === 0) {
      throw new Error(`workspace-src-alias guard: allowlist entry '${name}' needs a reason string`);
    }
  }
  const packageIndex = indexWorkspacePackages(packagesRoot);
  const violations = [];

  // Non-test specifiers per package, for transitive (src-graph) contributions.
  const transitiveCache = new Map();
  const transitiveSpecifiersFor = (name) => {
    if (!transitiveCache.has(name)) {
      const entry = packageIndex.get(name);
      transitiveCache.set(
        name,
        entry ? collectRuntimeWorkspaceSpecifiers(entry.dir, name, { includeTests: false }) : []
      );
    }
    return transitiveCache.get(name);
  };

  for (const [selfName, { dir: pkgDir }] of packageIndex) {
    const configs = listRunnableConfigs(pkgDir);
    assertConfigDiscoveryComplete(pkgDir, selfName, configs);
    if (configs.length === 0) {
      continue;
    }
    const allowEntry = allowlist[selfName];
    if (allowEntry && !allowEntry.specifiers) {
      continue; // whole package exempt (reason recorded in the allowlist)
    }
    const isAllowed = (specifier) => allowEntry?.specifiers?.includes(specifier) ?? false;
    const seedSpecifiers = collectRuntimeWorkspaceSpecifiers(pkgDir, selfName).filter(
      (specifier) => !isAllowed(specifier)
    );
    if (seedSpecifiers.length === 0) {
      continue;
    }
    for (const configName of configs) {
      const projects = await loadConfigProjects(join(pkgDir, configName));
      for (const { label, aliasEntries } of projects) {
        const problems = checkProject({
          aliasEntries,
          isAllowed,
          packageIndex,
          seedSpecifiers,
          selfName,
          transitiveSpecifiersFor,
        });
        for (const { specifier, problem } of problems) {
          violations.push({
            config: configName,
            package: selfName,
            problem,
            project: label,
            specifier,
          });
        }
      }
    }
  }
  return violations;
}
