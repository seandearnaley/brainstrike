import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Guards the narrowed `global.inputs` tsconfig contract in turbo.jsonc
 * (Series B2, PR #1649). The per-package tsconfig globs were removed from
 * the global inputs, which is only sound while three invariants hold:
 *
 *  (a) packages/config/tsconfig/ is the ONLY packages/<pkg>/tsconfig/ directory,
 *      so the kept "packages/*\/tsconfig/*.json" glob covers exactly the shared
 *      presets and a relocated/duplicated preset dir cannot silently escape it.
 *  (b) every tsconfig `extends` target resolves inside its own package dir
 *      (covered by that package's $TURBO_DEFAULT$ inputs), inside
 *      packages/config/tsconfig/ (covered by the kept preset glob), or to the
 *      repo-root tsconfig.json (covered by the kept root "tsconfig*.json" glob).
 *  (c) every cross-package project-`references` edge (tsc -b READS the
 *      referenced package's tsconfig) is mirrored by a direct or transitive
 *      workspace dependency in the owning package.json, so the ^build
 *      task-hash cascade carries the referenced tsconfig's content.
 *
 * A violation of any invariant creates an invisible cache input — the
 * #1066/#1207 stale-green class. Fix the offending tsconfig/package.json,
 * do not delete this test or re-broaden global.inputs.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspaceGlobs = ['packages', 'apps'];
const skipDirs = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  'release',
  '.turbo',
  '.claude',
]);

function stripJsonc(source) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  // Remove trailing commas left behind before } or ].
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readJsonc(filePath) {
  return JSON.parse(stripJsonc(readFileSync(filePath, 'utf8')));
}

function globalInputsFromTurboConfig(config) {
  assert.equal(
    config.futureFlags?.globalConfiguration,
    true,
    'turbo.jsonc must enable futureFlags.globalConfiguration while using the Turborepo 3.0 global block'
  );
  assert.equal(
    config.concurrency,
    undefined,
    'turbo.jsonc concurrency must live under global.concurrency, not the deprecated top-level key'
  );
  assert.equal(
    config.globalDependencies,
    undefined,
    'turbo.jsonc inputs must live under global.inputs, not the deprecated top-level globalDependencies key'
  );
  // A build/test parallelism calibration, inherited by CI's uncapped Build job
  // on a 4-vCPU runner. `turbo run dev`'s persistent-task floor is NOT this
  // number's problem — the root dev script carries its own --concurrency (see
  // turbo-global-configuration.test.mjs), so this stays pinned.
  assert.equal(
    config.global?.concurrency,
    '40',
    'turbo.jsonc must preserve the calibrated global concurrency of 40'
  );
  assert.ok(
    Array.isArray(config.global?.inputs),
    'turbo.jsonc must declare the Turborepo 3.0 global.inputs array'
  );
  assert.ok(
    config.global.inputs.length >= 7,
    `Only ${config.global.inputs.length} global input(s) remain (expected >= 7 after task-local guard inputs) — discovery or migration collapsed.`
  );
  return config.global.inputs;
}

function assertRequiredGlobalInput(config, requiredInput) {
  const globalInputs = globalInputsFromTurboConfig(config);
  assert.ok(
    globalInputs.includes(requiredInput),
    `turbo.jsonc global.inputs must keep "${requiredInput}" — it is a load-bearing cross-package cache input.`
  );
}

/** Workspace package dirs: packages/<name>, apps/<name> (those with a package.json). */
function workspacePackageDirs() {
  const dirs = [];
  for (const group of workspaceGlobs) {
    const groupDir = path.join(repoRoot, group);
    for (const entry of readdirSync(groupDir)) {
      const dir = path.join(groupDir, entry);
      try {
        if (statSync(dir).isDirectory() && statSync(path.join(dir, 'package.json')).isFile()) {
          dirs.push(dir);
        }
      } catch {
        // no package.json → not a workspace package
      }
    }
  }
  return dirs;
}

function collectTsconfigs(dir, results) {
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) {
      continue;
    }
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      collectTsconfigs(full, results);
    } else if (/^tsconfig.*\.json$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

const packageDirs = workspacePackageDirs();
const packageNameByDir = new Map(
  packageDirs.map((dir) => [dir, readJsonc(path.join(dir, 'package.json')).name])
);

/** The workspace package dir that contains the given absolute path, if any. */
function owningPackageDir(absPath) {
  return packageDirs.find((dir) => absPath === dir || absPath.startsWith(`${dir}${path.sep}`));
}

/** Direct workspace deps (all dependency blocks — turbo's topology uses them all). */
function directWorkspaceDeps(pkgDir) {
  const manifest = readJsonc(path.join(pkgDir, 'package.json'));
  const merged = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  const workspaceNames = new Set(packageNameByDir.values());
  return Object.keys(merged).filter((name) => workspaceNames.has(name));
}

/** Transitive closure of workspace dependency names reachable from pkgDir. */
function transitiveWorkspaceDeps(pkgDir) {
  const dirByName = new Map([...packageNameByDir].map(([dir, name]) => [name, dir]));
  const seen = new Set();
  const queue = directWorkspaceDeps(pkgDir);
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    queue.push(...directWorkspaceDeps(dirByName.get(name)));
  }
  return seen;
}

const allTsconfigs = packageDirs.flatMap((dir) => collectTsconfigs(dir, []));
const configPresetDir = path.join(repoRoot, 'packages', 'config', 'tsconfig');
const rootTsconfig = path.join(repoRoot, 'tsconfig.json');

test('(a) packages/config/tsconfig/ is the only packages/*/tsconfig/ directory', () => {
  const presetDirs = [];
  for (const group of workspaceGlobs) {
    for (const entry of readdirSync(path.join(repoRoot, group))) {
      const candidate = path.join(repoRoot, group, entry, 'tsconfig');
      try {
        if (statSync(candidate).isDirectory()) {
          presetDirs.push(path.relative(repoRoot, candidate));
        }
      } catch {
        // absent → fine
      }
    }
  }
  assert.deepEqual(
    presetDirs,
    ['packages/config/tsconfig'],
    `Only packages/config/tsconfig/ may exist as a <pkg>/tsconfig/ preset dir; found: ${presetDirs.join(', ')}. ` +
      'The turbo.jsonc global.inputs glob "packages/*/tsconfig/*.json" is calibrated to cover exactly the shared ' +
      'presets — a second preset dir would be hashed globally (over-invalidation) or, if relocated elsewhere, silently ' +
      'NOT hashed at all (#1066/#1207 stale-green class). Keep shared presets in packages/config/tsconfig/.'
  );
});

test('(b) every tsconfig extends target stays in-package, in the shared preset dir, or is the root tsconfig', () => {
  const violations = [];
  for (const tsconfigPath of allTsconfigs) {
    const config = readJsonc(tsconfigPath);
    if (config.extends === undefined) {
      continue;
    }
    const targets = Array.isArray(config.extends) ? config.extends : [config.extends];
    const ownDir = owningPackageDir(tsconfigPath);
    for (const target of targets) {
      if (!target.startsWith('.')) {
        violations.push(
          `${path.relative(repoRoot, tsconfigPath)} extends the non-relative specifier "${target}" — ` +
            'this contract only models raw relative extends; a package-specifier extends needs an explicit ruling ' +
            '(and a hash carrier) before use.'
        );
        continue;
      }
      let resolved = path.resolve(path.dirname(tsconfigPath), target);
      if (!resolved.endsWith('.json')) {
        resolved += '.json';
      }
      const inOwnPackage = resolved.startsWith(`${ownDir}${path.sep}`);
      const inPresetDir = resolved.startsWith(`${configPresetDir}${path.sep}`);
      const isRootTsconfig = resolved === rootTsconfig;
      if (!(inOwnPackage || inPresetDir || isRootTsconfig)) {
        violations.push(
          `${path.relative(repoRoot, tsconfigPath)} extends "${target}" → ${path.relative(repoRoot, resolved)}, ` +
            'which is outside its own package, packages/config/tsconfig/, and the repo-root tsconfig.json. ' +
            'Nothing hashes that file for this package (turbo.jsonc global.inputs only carries the root ' +
            'tsconfig + the config presets), so edits to it would replay stale-green caches.'
        );
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `tsconfig extends contract violations:\n${violations.join('\n')}`
  );
});

test('(c) every cross-package tsconfig references edge is mirrored by a workspace dependency', () => {
  const violations = [];
  for (const tsconfigPath of allTsconfigs) {
    const config = readJsonc(tsconfigPath);
    if (!Array.isArray(config.references) || config.references.length === 0) {
      continue;
    }
    const ownDir = owningPackageDir(tsconfigPath);
    const reachable = transitiveWorkspaceDeps(ownDir);
    for (const reference of config.references) {
      const resolved = path.resolve(path.dirname(tsconfigPath), reference.path);
      const targetDir = owningPackageDir(resolved);
      if (targetDir === ownDir) {
        continue; // local reference — hashed by the package's own default inputs
      }
      if (targetDir === undefined) {
        violations.push(
          `${path.relative(repoRoot, tsconfigPath)} references "${reference.path}" → ` +
            `${path.relative(repoRoot, resolved)}, which is not a workspace package — no hash carrier exists for it.`
        );
        continue;
      }
      const targetName = packageNameByDir.get(targetDir);
      if (!reachable.has(targetName)) {
        violations.push(
          `${path.relative(repoRoot, tsconfigPath)} has a project reference to ${targetName} ` +
            `("${reference.path}"), but ${packageNameByDir.get(ownDir)}'s package.json has no direct or transitive ` +
            'workspace dependency on it. tsc -b READS the referenced tsconfig, and only the ^build task-hash cascade ' +
            "(which follows package.json workspace deps) carries its content into this package's cache key. " +
            'Either add the workspace dependency (if the reference is real) or delete the stale reference.'
        );
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `tsconfig references contract violations:\n${violations.join('\n')}`
  );
});

test('turbo.jsonc uses the 3.0 global configuration and keeps both load-bearing tsconfig inputs', () => {
  const turboConfig = readJsonc(path.join(repoRoot, 'turbo.jsonc'));
  for (const requiredGlob of ['tsconfig*.json', 'packages/*/tsconfig/*.json']) {
    assertRequiredGlobalInput(turboConfig, requiredGlob);
  }
});

test('money controls: legacy layout and a missing global input both fail the contract', () => {
  const turboConfig = readJsonc(path.join(repoRoot, 'turbo.jsonc'));
  const legacyLayout = structuredClone(turboConfig);
  legacyLayout.futureFlags.globalConfiguration = false;
  legacyLayout.globalDependencies = legacyLayout.global.inputs;
  Reflect.deleteProperty(legacyLayout, 'global');

  assert.throws(
    () => globalInputsFromTurboConfig(legacyLayout),
    /futureFlags\.globalConfiguration/,
    'control failed: moving back to the deprecated layout must make the guard red'
  );

  const missingPresetInput = structuredClone(turboConfig);
  missingPresetInput.global.inputs = missingPresetInput.global.inputs.filter(
    (input) => input !== 'packages/*/tsconfig/*.json'
  );
  // Keep the entry-count floor satisfied so this control reaches the specific
  // load-bearing-input assertion it is intended to prove can fail.
  missingPresetInput.global.inputs.push('control-only-nonexistent-input');
  assert.throws(
    () => assertRequiredGlobalInput(missingPresetInput, 'packages/*/tsconfig/*.json'),
    /load-bearing cross-package cache input/,
    'control failed: deleting the shared-preset input must make the guard red'
  );
});
