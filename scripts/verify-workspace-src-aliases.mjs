// Guard against #1066/#1207 regressions: a package test lane that imports another
// @brainstrike/* workspace package at RUNTIME while the vitest config it runs
// under does not alias that specifier to SOURCE resolves it from BUILT dist
// (via package `exports`). Stale/broken dist then silently passes — the incident
// class.
//
// HOW IT WORKS (no marker strings — the configs are executed):
// 1. Per packages/* with a vitest config, collect every runtime `@brainstrike/*`
//    import SPECIFIER from its source/test files via TypeScript SYNTAX parsing
//    (static imports, `export ... from`, side-effect imports, dynamic
//    `import('...')`, CJS `require('...')`). Type-only declarations —
//    `import type`/`export type ... from`, including multiline forms and
//    all-`type` named-binding lists — are erased at compile time and ignored;
//    a mixed list (`import { type A, b }`) still loads the module and counts.
// 2. Enumerate the package's runnable vitest configs. Discovery is the
//    `vitest.*config*.*` filename convention, CROSS-CHECKED against reality:
//    every vitest `--config`/`-c` reference in the package's scripts and every
//    `configFile:` in its stryker config must be in the discovered set — a
//    reference the convention missed throws loudly (checked invariant, not a
//    silent gap). Each config is `import()`ed to get the REAL resolved object,
//    including inherited and merged inline-project aliases in Vitest 5.
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
import { fileURLToPath } from 'node:url';
// Syntax-only parsing (ts.createSourceFile) to classify imports; no type check.
import ts from 'typescript';
// Real Vite config loader (esbuild-bundles the config file), not a plain
// `import()`: apps/*/vitest.config.mts contain extensionless local imports
// (e.g. '../../packages/test-utils/src/test-timeouts') that Vite/Vitest's own
// bundler-based config loading tolerates but plain Node ESM resolution does
// not. Using the same loader Vite/Vitest use for real keeps this guard's
// "execute the real config" premise honest for apps/*, not just packages/*.
import { loadConfigFromFile, mergeConfig } from 'vite';
import { resolveThroughAliases } from '../packages/test-utils/workspace-src-aliases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseRepoRootArgument(argv) {
  if (argv.length === 0) {
    return;
  }
  const [argument, value] = argv;
  if (argv.length !== 2 || argument !== '--repo-root' || !value || value.startsWith('--')) {
    throw new Error('verify-workspace-src-aliases: expected only --repo-root <path>');
  }
  return resolve(value);
}

/**
 * Packages allowed to consume built artifacts from a test lane, keyed by
 * package name. Value: { reason: string, specifiers?: string[], configs?: string[] } — when
 * `specifiers` is present only those exact specifiers are exempt; otherwise the
 * whole package is. Keep this list short and justified.
 */
export const WORKSPACE_SRC_ALIAS_ALLOWLIST = Object.freeze({
  '@brainstrike/canonical-ingestion': {
    configs: ['vitest.integration.config.mts'],
    reason:
      'The vector host integration proof launches the real compiled index process; the lane declares its indexer build edge.',
    specifiers: ['@brainstrike/indexer'],
  },
  '@brainstrike/desktop': {
    configs: ['vitest.integration.config.mts'],
    reason:
      'The uncached native integration lane launches compiled index/query processes; explicit build edges prepare their public artifacts.',
    specifiers: [
      '@brainstrike/indexer',
      '@brainstrike/indexer/transport',
      '@brainstrike/sqlite-query',
    ],
  },
  '@brainstrike/indexer': {
    reason:
      'The native process integration lane consumes emitted public artifacts so Node can launch the compiled process and writer worker; its own build edge is explicit.',
    specifiers: ['@brainstrike/indexer'],
  },
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

/** True when an import declaration is fully erased at compile time. */
function isTypeOnlyImport(node) {
  const clause = node.importClause;
  if (!clause) {
    return false; // side-effect import — always runtime
  }
  if (clause.isTypeOnly) {
    return true; // import type { ... } / import type Default (incl. multiline)
  }
  if (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    const elements = clause.namedBindings.elements;
    // `import { type A, type B } from ...` erases; a single runtime binding
    // (`import { type A, b } from ...`) keeps the module load.
    return elements.length > 0 && elements.every((element) => element.isTypeOnly);
  }
  return false;
}

/** True when an `export ... from` declaration is fully erased at compile time. */
function isTypeOnlyReExport(node) {
  if (node.isTypeOnly) {
    return true; // export type { ... } from ...
  }
  if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    const elements = node.exportClause.elements;
    return elements.length > 0 && elements.every((element) => element.isTypeOnly);
  }
  return false;
}

/** True for dynamic `import('...')` and CJS `require('...')` call shapes. */
function isRuntimeModuleCall(node) {
  return (
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

/**
 * Parse one source file (syntax only — no type checking) and collect its
 * RUNTIME module specifiers. Uses the repo's own `typescript` package so
 * multiline `import type { ... } from '...'` declarations are classified
 * correctly — a line-level regex misread their closing `} from '...'` line as
 * a runtime import.
 */
export function collectFileRuntimeSpecifiers(filePath, text) {
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const specifiers = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (!isTypeOnlyImport(node)) {
        specifiers.add(node.moduleSpecifier.text);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      if (!isTypeOnlyReExport(node)) {
        specifiers.add(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && isRuntimeModuleCall(node)) {
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

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
    for (const specifier of collectFileRuntimeSpecifiers(file, readFileSync(file, 'utf8'))) {
      if (
        specifier.startsWith('@brainstrike/') &&
        specifier.split('/').slice(0, 2).join('/') !== selfName
      ) {
        specifiers.add(specifier);
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
 * `[{ label, aliasEntries }]`. Vitest 5 inline projects inherit the root
 * unless extends is false or names a different config file.
 */
export async function loadConfigProjects(configPath) {
  const result = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    configPath,
    dirname(configPath)
  );
  const cfg = result?.config;
  if (!cfg || typeof cfg !== 'object') {
    throw new Error(`workspace-src-alias guard: ${configPath} has no default-export config`);
  }
  const projects = cfg.test?.projects;
  if (Array.isArray(projects)) {
    return Promise.all(
      projects
        .filter((project) => project && typeof project === 'object')
        .map(async (project, index) => {
          let base = cfg;
          if (project.extends === false) {
            base = {};
          } else if (typeof project.extends === 'string') {
            const extendedPath = resolve(dirname(configPath), project.extends);
            const extended = await loadConfigFromFile(
              { command: 'serve', mode: 'test' },
              extendedPath,
              dirname(configPath)
            );
            if (!extended?.config) {
              throw new Error(`workspace-src-alias guard: cannot load ${extendedPath}`);
            }
            base = extended.config;
          }
          const effective = mergeConfig(base, project);
          return {
            aliasEntries: normalizeAliasEntries(effective.resolve?.alias),
            label: project.test?.name ?? `project#${index}`,
          };
        })
    );
  }
  return [{ aliasEntries: normalizeAliasEntries(cfg.resolve?.alias), label: 'root' }];
}

// Re-exported (not duplicated) from the registry module itself (imported
// above): app-level vite-config alias-contract tests
// (apps/*/src/__tests__/vite-config.test.ts, Series C R6 task 5) need the
// exact same first-match simulation but cannot import from `scripts/`
// (outside their tsconfig project's `rootDir`) — they import it from
// `@brainstrike/test-utils/workspace-src-aliases` instead, where this guard
// also gets it from. Re-exported here for this module's existing consumers
// that still import it from this file.
export { resolveThroughAliases };

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
 * Scan `packagesRoot` (and, when given, `appsRoot`) and return violations:
 * `{ package, config, project, specifier, problem }[]`. `appsRoot` is OPT-IN
 * (default: not scanned) so existing packagesRoot-only fixture tests keep
 * their exact prior behavior; the real-tree "no package test lane resolves
 * workspace imports from dist" test passes it explicitly to also cover
 * apps/web and apps/desktop (Series C R6 task 5) — an app alias that drifts
 * from source-resolution fails this guard exactly like a package's would.
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
  if (options.appsRoot) {
    for (const [name, entry] of indexWorkspacePackages(options.appsRoot)) {
      packageIndex.set(name, entry);
    }
  }
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
    if (allowEntry && !allowEntry.specifiers && !allowEntry.configs) {
      continue; // whole package exempt (reason recorded in the allowlist)
    }
    const allSpecifiers = collectRuntimeWorkspaceSpecifiers(pkgDir, selfName);
    if (allSpecifiers.length === 0) {
      continue;
    }
    for (const configName of configs) {
      const isAllowed = (specifier) =>
        (!allowEntry?.configs || allowEntry.configs.includes(configName)) &&
        (allowEntry?.specifiers?.includes(specifier) ?? false);
      const seedSpecifiers = allSpecifiers.filter((specifier) => !isAllowed(specifier));
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

/**
 * BST-836: this module shipped without an entrypoint, so
 * `node scripts/verify-workspace-src-aliases.mjs` exited 0 while checking
 * nothing.
 *
 * `appsRoot` is passed explicitly to mirror the CI-wired paired test — the
 * function's own default covers packages/ only, and a CLI that quietly checked
 * a narrower tree than CI would be a second, weaker verdict under the same name.
 *
 * @param {{ repoRoot?: string }} options
 */
export async function main(options = {}) {
  const repoRoot = options.repoRoot ?? resolve(HERE, '..');
  const appsRoot = join(repoRoot, 'apps');
  const packagesRoot = join(repoRoot, 'packages');
  if (!existsSync(packagesRoot)) {
    throw new Error(`verify-workspace-src-aliases: missing packages/ under repo root ${repoRoot}`);
  }
  if (!existsSync(appsRoot)) {
    throw new Error(`verify-workspace-src-aliases: missing apps/ under repo root ${repoRoot}`);
  }
  const violations = await findWorkspaceSrcAliasViolations({
    appsRoot,
    packagesRoot,
  });
  if (violations.length === 0) {
    console.log(
      'verify-workspace-src-aliases: OK (every package and app test lane resolves @brainstrike/* ' +
        'imports from source, not built dist)'
    );
    return;
  }
  console.error(
    'Package/app test lanes resolve @brainstrike/* imports from built dist ' +
      '(spread `...workspaceSrcAliases(...)` in the flagged config/project, or allowlist with a reason):'
  );
  console.error(
    violations
      .map((v) => `  - ${v.package} [${v.config} / ${v.project}] ${v.specifier}: ${v.problem}`)
      .join('\n')
  );
  process.exitCode = 1;
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main({ repoRoot: parseRepoRootArgument(process.argv.slice(2)) });
}
