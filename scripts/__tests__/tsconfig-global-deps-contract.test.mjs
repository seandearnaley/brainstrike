import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Guards the narrowed `globalDependencies` tsconfig contract in turbo.jsonc
 * (Series B2, PR #1649). The per-package tsconfig globs were removed from
 * globalDependencies, which is only sound while three invariants hold:
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
 * do not delete this test or re-broaden globalDependencies.
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
      'The turbo.jsonc globalDependencies glob "packages/*/tsconfig/*.json" is calibrated to cover exactly the shared ' +
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
            'Nothing hashes that file for this package (turbo.jsonc globalDependencies only carries the root ' +
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

test('turbo.jsonc keeps the two load-bearing tsconfig globs in globalDependencies', () => {
  const turboConfig = readJsonc(path.join(repoRoot, 'turbo.jsonc'));
  const globalDependencies = turboConfig.globalDependencies ?? [];
  for (const requiredGlob of ['tsconfig*.json', 'packages/*/tsconfig/*.json']) {
    assert.ok(
      globalDependencies.includes(requiredGlob),
      `turbo.jsonc globalDependencies must keep "${requiredGlob}" — it is the sole hash carrier for a tsconfig ` +
        'read across package boundaries (root tsconfig for config#type-check; packages/config/tsconfig/base.json ' +
        'for its ~40 raw-path extends consumers). Removing it recreates the #1066/#1207 invisible-input class.'
    );
  }
});
