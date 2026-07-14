// Guard against the B4 CONFIG-LOAD hash-gap class (sibling of
// verify-workspace-src-aliases.mjs, found in the #1658 adversarial review):
// a package's vitest config (or a setup/globalSetup file it declares) can
// IMPORT/EXECUTE another workspace package's files at config-load time.
// Since B4 replaced `test.dependsOn: ["^build"]` with the `topo` transit node,
// the ONLY things that invalidate a cached test are the package's own inputs
// plus the `^topo` cascade over its DECLARED package.json dependencies. A
// config-load reference to a package with NO dependency edge and NO explicit
// turbo.json input is therefore invisible to the hash: editing the executed
// file replays the consumer's stale cached green — the #1066/#1207 class at
// the config layer. The five pre-fix instances (regression fixtures for this
// guard's tests): server-config -> test-utils' vitest.setup (setupFiles);
// embedding-worker + ui -> config's vitest-browser.ts (import); db-explorer +
// vector-management -> agent's browser-safe-subpath-aliases.mjs (import).
//
// HOW IT WORKS:
// 1. Per packages/* with vitest configs (same filename convention + discovery
//    cross-check as the alias guard), build the CONFIG-LOAD file closure: the
//    config files themselves plus, transitively, every same-package file they
//    import at load time. Each config is also EXECUTED (like the alias guard)
//    to read the REAL `test.setupFiles` / `test.globalSetup` (top-level and
//    per inline project — projects do not inherit them), because those files
//    are executed by every lane run too.
// 2. Collect every cross-package reference from that closure: a runtime import
//    of a RELATIVE path resolving into another packages/* dir, a bare
//    `@brainstrike/*` specifier, or a setup/globalSetup path pointing into
//    another package.
// 3. A reference is COVERED when (any of):
//      (a) the consumer's package.json declares the owning package in
//          dependencies/devDependencies — the owner's `^topo` then carries the
//          file's hash into the consumer's test hash;
//      (b) the consumer's turbo.json declares the exact file as a
//          `$TURBO_ROOT$/...` input on the `test` task AND (when the package
//          has a test:coverage script) on `test:coverage` — the app-shell
//          precedent, for defensive references where a dependency edge would
//          be semantically wrong or cyclic (bare specifiers cannot use this
//          escape: they name a package, not a file);
//      (c) an allowlist entry with a reason string (same semantics as the
//          alias guard: whole-package, or per-reference via `references`).
//    Anything else is a violation. NO silent fallbacks.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertConfigDiscoveryComplete,
  collectFileRuntimeSpecifiers,
  listRunnableConfigs,
} from './verify-workspace-src-aliases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Allowlist for legitimate uncovered config-load references, keyed by package
 * name. Value: { reason: string, references?: string[] } — `references` holds
 * the exact specifier / relative path strings that are exempt; without it the
 * whole package is. Keep short and justified.
 */
export const CONFIG_LOAD_HASH_ALLOWLIST = Object.freeze({
  // (currently empty — every config-load cross-package reference is covered by
  // a dependency edge or an explicit turbo.json input.)
});

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js'];

/** Resolve a relative import to an existing file (extension/index probing). */
function resolveRelativeImport(fromDir, specifier) {
  const base = resolve(fromDir, specifier);
  const candidates = [base, ...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`)];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = join(base, `index${ext}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Map packages-root subdirectories to { name, dir }. */
function indexPackages(packagesRoot) {
  const index = [];
  for (const entry of readdirSync(packagesRoot)) {
    const dir = join(packagesRoot, entry);
    const pkgJson = join(dir, 'package.json');
    if (!(statSync(dir).isDirectory() && existsSync(pkgJson))) {
      continue;
    }
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
    if (typeof pkg.name === 'string') {
      index.push({ dir, name: pkg.name, pkg });
    }
  }
  return index;
}

/** Owning package entry for an absolute path, or null. */
function owningPackage(absPath, packageIndex) {
  for (const entry of packageIndex) {
    if (absPath === entry.dir || absPath.startsWith(entry.dir + sep)) {
      return entry;
    }
  }
  return null;
}

/** Setup/globalSetup path strings from an EXECUTED config (all projects). */
async function collectSetupPaths(configPath) {
  const mod = await import(pathToFileURL(configPath).href);
  const cfg = mod.default;
  if (!cfg || typeof cfg !== 'object') {
    throw new Error(`config-load hash guard: ${configPath} has no default-export config`);
  }
  const paths = [];
  const pushFrom = (testSection) => {
    if (!testSection) {
      return;
    }
    for (const key of ['setupFiles', 'globalSetup']) {
      const value = testSection[key];
      if (typeof value === 'string') {
        paths.push(value);
      } else if (Array.isArray(value)) {
        paths.push(...value.filter((v) => typeof v === 'string'));
      }
    }
  };
  pushFrom(cfg.test);
  for (const project of cfg.test?.projects ?? []) {
    if (project && typeof project === 'object') {
      pushFrom(project.test);
    }
  }
  return paths;
}

/**
 * Config-load import closure for one package: starts at its vitest configs,
 * follows runtime RELATIVE imports transitively while they stay inside the
 * package, and records every cross-package reference (relative file escape or
 * bare workspace specifier).
 */
function collectConfigLoadReferences({ configFiles, selfName, packageIndex }) {
  const references = [];
  const visited = new Set();
  const queue = [...configFiles];
  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    const specifiers = collectFileRuntimeSpecifiers(file, readFileSync(file, 'utf8'));
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const resolved = resolveRelativeImport(dirname(file), specifier);
        if (!resolved) {
          continue; // unresolvable relative import — vitest itself will fail loudly
        }
        const owner = owningPackage(resolved, packageIndex);
        if (owner && owner.name === selfName) {
          queue.push(resolved); // same-package helper: keep walking the closure
        } else if (owner) {
          references.push({ file: resolved, owner: owner.name, raw: specifier, via: file });
        }
        // Files outside packages/* (repo root scripts, apps) are out of this
        // guard's scope — mirrors the alias guard's packages/* boundary.
      } else if (specifier.startsWith('@brainstrike/')) {
        const ownerName = specifier.split('/').slice(0, 2).join('/');
        if (ownerName !== selfName) {
          references.push({ file: null, owner: ownerName, raw: specifier, via: file });
        }
      }
    }
  }
  return references;
}

/** Read declared turbo.json `$TURBO_ROOT$` file inputs for the given task. */
function turboRootInputs(pkgDir, taskName) {
  const turboPath = join(pkgDir, 'turbo.json');
  if (!existsSync(turboPath)) {
    return [];
  }
  // turbo.json files in this repo carry // comments — strip string-safely
  // enough for these small configs (no URLs outside quotes).
  const raw = readFileSync(turboPath, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const parsed = JSON.parse(raw);
  const inputs = parsed.tasks?.[taskName]?.inputs ?? [];
  return inputs.filter((entry) => typeof entry === 'string' && entry.startsWith('$TURBO_ROOT$/'));
}

/** True when turbo.json inputs cover the file for every relevant lane. */
function coveredByTurboInputs({ file, pkg, pkgDir, repoRoot }) {
  const repoRel = relative(repoRoot, file).split(sep).join('/');
  const wanted = `$TURBO_ROOT$/${repoRel}`;
  if (!turboRootInputs(pkgDir, 'test').includes(wanted)) {
    return false;
  }
  const hasCoverageScript = typeof pkg.scripts?.['test:coverage'] === 'string';
  return hasCoverageScript ? turboRootInputs(pkgDir, 'test:coverage').includes(wanted) : true;
}

/**
 * Find config-load cross-package references not covered by a dependency edge,
 * an explicit turbo.json input, or the allowlist.
 *
 * @param {{ packagesRoot?: string, repoRoot?: string, allowlist?: object }} options
 * @returns {Promise<{ package: string, config: string, reference: string, owner: string, problem: string }[]>}
 */
export async function findConfigLoadHashGaps(options = {}) {
  const repoRoot = options.repoRoot ?? resolve(HERE, '..');
  const packagesRoot = options.packagesRoot ?? join(repoRoot, 'packages');
  const allowlist = options.allowlist ?? CONFIG_LOAD_HASH_ALLOWLIST;
  for (const [name, entry] of Object.entries(allowlist)) {
    if (typeof entry?.reason !== 'string' || entry.reason.length === 0) {
      throw new Error(`config-load hash guard: allowlist entry for ${name} needs a reason string`);
    }
  }
  const effectiveRepoRoot = options.packagesRoot ? resolve(packagesRoot, '..') : repoRoot;
  const packageIndex = indexPackages(packagesRoot);
  const violations = [];

  for (const { dir: pkgDir, name: selfName, pkg } of packageIndex) {
    const configNames = listRunnableConfigs(pkgDir);
    assertConfigDiscoveryComplete(pkgDir, selfName, configNames);
    if (configNames.length === 0) {
      continue;
    }
    const allowEntry = allowlist[selfName];
    if (allowEntry && !allowEntry.references) {
      continue; // whole package exempt (reason recorded in the allowlist)
    }
    const isAllowed = (raw) => allowEntry?.references?.includes(raw) ?? false;
    const declaredDeps = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);

    const configFiles = configNames.map((name) => join(pkgDir, name));
    const references = collectConfigLoadReferences({
      configFiles,
      packageIndex,
      selfName,
    });
    // Setup/globalSetup files from the EXECUTED configs (comments and dead
    // code cannot produce entries; inline projects contribute their own).
    for (const configPath of configFiles) {
      for (const setupPath of await collectSetupPaths(configPath)) {
        if (!(setupPath.startsWith('.') || isAbsolute(setupPath))) {
          // Bare specifier (e.g. '@brainstrike/test-utils/vitest.setup').
          if (setupPath.startsWith('@brainstrike/')) {
            const ownerName = setupPath.split('/').slice(0, 2).join('/');
            if (ownerName !== selfName) {
              references.push({ file: null, owner: ownerName, raw: setupPath, via: configPath });
            }
          }
          continue;
        }
        const resolved = isAbsolute(setupPath)
          ? setupPath
          : resolveRelativeImport(pkgDir, setupPath);
        if (!resolved) {
          continue; // vitest will fail loudly on a missing setup file
        }
        const owner = owningPackage(resolved, packageIndex);
        if (owner && owner.name !== selfName) {
          references.push({ file: resolved, owner: owner.name, raw: setupPath, via: configPath });
        }
      }
    }

    for (const reference of references) {
      if (isAllowed(reference.raw) || declaredDeps.has(reference.owner)) {
        continue;
      }
      if (
        reference.file &&
        coveredByTurboInputs({ file: reference.file, pkg, pkgDir, repoRoot: effectiveRepoRoot })
      ) {
        continue;
      }
      violations.push({
        config: relative(pkgDir, reference.via),
        owner: reference.owner,
        package: selfName,
        problem:
          `config-load reference '${reference.raw}' executes ${reference.owner}'s file, but ` +
          `${selfName} declares no dependency on ${reference.owner}` +
          (reference.file
            ? ` and no turbo.json '$TURBO_ROOT$' input covers it — an edit to the executed ` +
              'file will replay a stale cached test (B4 topo cascade only follows declared deps). ' +
              'Add the dependency, or mirror packages/app-shell/turbo.json (explicit inputs on ' +
              'test AND test:coverage), or allowlist with a reason.'
            : ' — add the dependency or allowlist with a reason.'),
        reference: reference.raw,
      });
    }
  }
  return violations;
}
