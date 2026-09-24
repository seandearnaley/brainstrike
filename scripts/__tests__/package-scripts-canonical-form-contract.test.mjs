import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * Guards the canonical shape of the per-package `clean` and `type-check` scripts
 * that Series B1 (PR #1650) collapsed behind shared forms. ~20 manifests were
 * normalized so the build graph reads one predictable command per script; this
 * contract stops them from silently drifting back into bespoke shapes.
 *
 * Canonical forms:
 *   clean        →  node <up-to-repo-root>/scripts/rimraf.mjs dist .tsbuildinfo
 *                    (the `../` depth is relative — 2 for packages/<name> and
 *                    apps/<name>, 3 for the nested packages/config/<name> — see
 *                    canonicalCleanFor(); a flat literal would silently accept a
 *                    broken path for any package at a different nesting depth)
 *   type-check   →  tsc --noEmit
 *              or   tsc --noEmit && tsc --noEmit --project tsconfig.test.json
 *   lint         →  pnpm -w lint
 *                    (the alias must carry NO extra args: pnpm appends anything
 *                    after the script name to the LAST command of the root
 *                    lint's && chain, silently breaking biome — the
 *                    `pnpm -w lint --filter @brainstrike/<pkg>` form was broken
 *                    this way since #519. `-w` is also depth-independent,
 *                    unlike the retired `pnpm run --dir=../.. lint` form.)
 *
 * The contract governs clean COVERAGE as well as script shape: every package
 * with a build script must declare clean so the root clean graph cannot leave a
 * stale package artifact behind. Packages without a build may omit clean.
 * Type-check remains shape-only because some packages legitimately omit it.
 * Any script that is present must match the canonical form unless the owning
 * package is on the documented allowlist below.
 *
 * Allowlist discipline (the meta-tests at the bottom enforce it): every allowlist
 * entry must name a real workspace package whose script GENUINELY diverges. A
 * package that already matches the canonical form must NOT be allowlisted — a
 * dead exemption would permanently blind this guard to future drift in that
 * package (the #1066/#1207 stale-green class). If a divergence is resolved,
 * delete the exemption; the meta-test will fail until you do.
 *
 * To fix a failure: change the offending package.json script to the canonical
 * form. Only add an allowlist entry when the divergence is load-bearing, and
 * document why. Do not weaken this contract to make a drifted script pass.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The canonical `clean` form is depth-relative, not a flat literal: it must
 * reach the repo-root `scripts/rimraf.mjs` via as many `../` segments as the
 * package sits below the repo root. `packages/<name>` and `apps/<name>` sit 2
 * levels down (`../../scripts/...`); the nested `packages/config/<name>` sits 3
 * levels down (`../../../scripts/...`). A single hardcoded literal would either
 * silently accept a broken path for a differently-nested package, or reject a
 * correct one — caught by review against packages/config/tsconfig.
 */
function canonicalCleanFor(relDir) {
  const depth = relDir.split(path.sep).length;
  return `node ${'../'.repeat(depth)}scripts/rimraf.mjs dist .tsbuildinfo`;
}

const CANONICAL_TYPE_CHECK_FORMS = [
  'tsc --noEmit',
  'tsc --noEmit && tsc --noEmit --project tsconfig.test.json',
  // A package that depends on `effect` appends the Effect language service in
  // dedicated diagnostics mode (docs/agents/effect-boundary.md § "Effect
  // diagnostics"; scripts/__tests__/effect-boundary-contract.test.mjs).
  'tsc --noEmit && tsc --noEmit --project tsconfig.test.json && effect-tsgo diagnostics --project tsconfig.test.json --strict',
];

/**
 * The one canonical per-package lint alias. `-w` runs the root `lint` script
 * regardless of package nesting depth, and — critically — the alias carries no
 * trailing args: pnpm forwards anything after the script name to the LAST
 * command of the root script's && chain (all pnpm versions), so a form like
 * `pnpm -w lint --filter @brainstrike/<pkg>` hands `--filter …` to biome and
 * has been silently broken since #519.
 */
const CANONICAL_LINT = 'pnpm -w lint';

/**
 * Packages whose `clean` legitimately diverges from the canonical rimraf form.
 * name → documented reason.
 */
const CLEAN_ALLOWLIST = new Map([
  [
    '@brainstrike/ui',
    'prepends `pnpm run clean:generated` to drop generated sources before the shared rimraf pass',
  ],
  [
    '@brainstrike/secure-fs-native',
    'native addon — removes node-gyp build output instead of TypeScript dist artifacts',
  ],
  [
    '@brainstrike/windows-job-native',
    'native addon — removes node-gyp build output instead of TypeScript dist artifacts',
  ],
]);

/**
 * Packages whose `type-check` legitimately diverges from the allowed tsc --noEmit
 * forms. name → documented reason.
 */
const TYPE_CHECK_ALLOWLIST = new Map([
  [
    '@brainstrike/app-shell',
    'composite project — type-checks via `tsconfig.typecheck.json` + `tsconfig.test.json`',
  ],
  [
    '@brainstrike/secure-fs-native',
    'native CJS package (no TypeScript) — validates syntax with `node --check index.cjs`',
  ],
  [
    '@brainstrike/windows-job-native',
    'native CJS package (no TypeScript) — validates syntax with `node --check index.cjs`',
  ],
  [
    '@brainstrike/web',
    'app — `tsc --build --force` primes referenced-project outputs before the --noEmit passes',
  ],
  [
    '@brainstrike/desktop',
    'app — splits main + test + e2e type-checks via `pnpm type-check:main && pnpm type-check:test && pnpm type-check:e2e`',
  ],
]);

/**
 * Packages whose `lint` legitimately diverges from the canonical root alias:
 * they run a package-scoped linter directly instead of aliasing the whole-repo
 * root lint. name → documented reason.
 */
const LINT_ALLOWLIST = new Map([
  ['@brainstrike/desktop', 'app — runs a desktop-scoped `biome check .` instead of the root lint'],
  ['@brainstrike/embeddings', 'runs a package-scoped `biome check .` instead of the root lint'],
  [
    '@brainstrike/pipeline',
    'runs the package-scoped `ultracite check src` preset instead of the root lint',
  ],
]);

/** Collapse runs of whitespace and trim so cosmetic spacing is not a divergence. */
function normalize(script) {
  return script.trim().replace(/\s+/g, ' ');
}

/**
 * Workspace package globs, read from pnpm-workspace.yaml (the single source of
 * truth) rather than hardcoded, so a newly-added group cannot silently escape
 * the "every package" coverage this contract promises.
 */
function readWorkspaceGlobs() {
  const yaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [];
  let inPackages = false;
  for (const rawLine of yaml.split('\n')) {
    if (/^packages:\s*$/.test(rawLine)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const item = rawLine.match(/^\s+-\s+['"]?([^'"]+?)['"]?\s*$/);
    if (item) {
      globs.push(item[1]);
      continue;
    }
    if (/^\S/.test(rawLine)) {
      break; // next top-level key ends the packages block
    }
  }
  return globs;
}

/**
 * Absolute dirs of every workspace package (a dir with a package.json), each
 * tagged with the pnpm-workspace.yaml glob group that produced it. The group
 * tag lets the vacuous-enumeration test below detect a specific glob group
 * silently yielding zero packages, not just a total wipeout.
 */
function workspacePackageDirs() {
  const dirs = new Map(); // absolute dir → originating glob group
  for (const glob of readWorkspaceGlobs()) {
    const match = glob.match(/^(.+)\/\*$/);
    if (!match) {
      // NO SILENT FALLBACK: an unfamiliar glob shape (including pnpm exclusion
      // globs like "!apps/legacy" or recursive "apps/**") would under-enumerate
      // and fake a green. Surface it so the enumerator is taught the new shape.
      throw new Error(
        `pnpm-workspace.yaml contains the package glob "${glob}", which this contract does not know how to ` +
          'enumerate (it only supports single-level "<dir>/*" globs — pnpm exclusion/recursive glob forms are ' +
          'not handled). Update workspacePackageDirs() in ' +
          'scripts/__tests__/package-scripts-canonical-form-contract.test.mjs before this glob can hide a package.'
      );
    }
    const groupDir = path.join(repoRoot, match[1]);
    let entries;
    try {
      entries = readdirSync(groupDir);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err; // NO SILENT FALLBACK: only a genuinely-absent group dir is skippable
      }
      continue; // group dir absent → nothing to enumerate
    }
    for (const entry of entries) {
      const dir = path.join(groupDir, entry);
      try {
        if (statSync(dir).isDirectory() && statSync(path.join(dir, 'package.json')).isFile()) {
          dirs.set(dir, glob);
        }
      } catch {
        // not a package dir
      }
    }
  }
  return [...dirs.entries()].map(([dir, group]) => ({ dir, group }));
}

const packages = workspacePackageDirs().map(({ dir, group }) => {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return {
    dir,
    group,
    name: manifest.name,
    relDir: path.relative(repoRoot, dir),
    scripts: manifest.scripts ?? {},
  };
});
const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));

test('root clean routes every package clean script through an uncached Turbo task', () => {
  const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(
    rootManifest.scripts.clean,
    'node scripts/run-turbo-command.mjs -- run clean --summarize --log-order=grouped'
  );

  const dryRun = JSON.parse(
    execFileSync(
      process.execPath,
      // Node 24 rejects Windows batch shims passed to execFileSync, so execute
      // Turbo's package-resolved JavaScript entrypoint through Node itself.
      [require.resolve('turbo/bin/turbo'), 'run', 'clean', '--dry=json'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NO_UPDATE_NOTIFIER: '1',
          TURBO_TELEMETRY_DISABLED: '1',
        },
      }
    )
  );
  const runnableTasks = dryRun.tasks.filter((task) => task.command !== '<NONEXISTENT>');
  const actualCleanPackages = runnableTasks.map((task) => task.package).sort();
  const expectedCleanPackages = packages
    .filter((pkg) => pkg.scripts.clean !== undefined)
    .map((pkg) => pkg.name)
    .sort();

  assert.deepEqual(
    actualCleanPackages,
    expectedCleanPackages,
    'Turbo must discover every workspace package that declares a clean script'
  );
  for (const task of runnableTasks) {
    assert.deepEqual(
      task.resolvedTaskDefinition.dependsOn,
      [],
      `${task.taskId} must stay independent`
    );
    assert.equal(task.resolvedTaskDefinition.cache, false, `${task.taskId} must never be cached`);
    assert.deepEqual(
      task.resolvedTaskDefinition.outputs,
      [],
      `${task.taskId} must declare no outputs`
    );
  }
});

test('every build script has a clean script', () => {
  const violations = packages
    .filter((pkg) => pkg.scripts.build !== undefined && pkg.scripts.clean === undefined)
    .map(
      (pkg) =>
        `${pkg.relDir} (${pkg.name}) declares build but no clean script, so root pnpm clean would leave its outputs behind.`
    );

  assert.deepEqual(
    violations,
    [],
    `Build packages without clean scripts:\n${violations.join('\n')}`
  );
});

test('every package clean script matches the canonical rimraf form', () => {
  const violations = [];
  for (const pkg of packages) {
    const clean = pkg.scripts.clean;
    if (clean === undefined || CLEAN_ALLOWLIST.has(pkg.name)) {
      continue;
    }
    const canonicalClean = canonicalCleanFor(pkg.relDir);
    if (normalize(clean) !== normalize(canonicalClean)) {
      violations.push(
        `${pkg.relDir} (${pkg.name}) has clean = ${JSON.stringify(clean)}, but the canonical form is ` +
          `${JSON.stringify(canonicalClean)}. Restore the canonical form, or — if this package legitimately ` +
          'needs a different clean — add it to CLEAN_ALLOWLIST with a documented reason.'
      );
    }
  }
  assert.deepEqual(violations, [], `Non-canonical clean scripts:\n${violations.join('\n')}`);
});

test('every package type-check script matches an allowed tsc --noEmit form', () => {
  const allowedForms = CANONICAL_TYPE_CHECK_FORMS.map(normalize);
  const allowedDisplay = CANONICAL_TYPE_CHECK_FORMS.map((form) => JSON.stringify(form)).join(
    ' or '
  );
  const violations = [];
  for (const pkg of packages) {
    const typeCheck = pkg.scripts['type-check'];
    if (typeCheck === undefined || TYPE_CHECK_ALLOWLIST.has(pkg.name)) {
      continue;
    }
    if (!allowedForms.includes(normalize(typeCheck))) {
      violations.push(
        `${pkg.relDir} (${pkg.name}) has type-check = ${JSON.stringify(typeCheck)}, but the allowed forms are ` +
          `${allowedDisplay}. Restore an allowed form, or — if this package legitimately diverges — add it to ` +
          'TYPE_CHECK_ALLOWLIST with a documented reason.'
      );
    }
  }
  assert.deepEqual(violations, [], `Non-canonical type-check scripts:\n${violations.join('\n')}`);
});

test('every package lint script is the canonical root alias with no extra args', () => {
  const violations = [];
  for (const pkg of packages) {
    const lint = pkg.scripts.lint;
    if (lint === undefined || LINT_ALLOWLIST.has(pkg.name)) {
      continue;
    }
    if (normalize(lint) !== CANONICAL_LINT) {
      const carriesArgs = /pnpm (-w|--dir\S*) .*lint .+/.test(normalize(lint));
      const argsWarning = carriesArgs
        ? ' This alias carries extra args after the script name — pnpm forwards them to the LAST command of the ' +
          "root lint's && chain (biome), silently breaking it (#519)."
        : '';
      violations.push(
        `${pkg.relDir} (${pkg.name}) has lint = ${JSON.stringify(lint)}, but the canonical alias is ` +
          `${JSON.stringify(CANONICAL_LINT)}.${argsWarning} Restore the canonical form, or — if this package ` +
          'legitimately runs its own scoped linter — add it to LINT_ALLOWLIST with a documented reason.'
      );
    }
  }
  assert.deepEqual(violations, [], `Non-canonical lint scripts:\n${violations.join('\n')}`);
});

test('CLEAN_ALLOWLIST has no dead entries (each listed package actually diverges)', () => {
  const violations = [];
  for (const [name] of CLEAN_ALLOWLIST) {
    const pkg = packagesByName.get(name);
    if (!pkg) {
      violations.push(
        `${name} is in CLEAN_ALLOWLIST but is not a workspace package (typo or removed?).`
      );
      continue;
    }
    const clean = pkg.scripts.clean;
    if (clean === undefined) {
      violations.push(
        `${name} is in CLEAN_ALLOWLIST but has no clean script — there is nothing to exempt. Remove the entry.`
      );
      continue;
    }
    const canonicalClean = canonicalCleanFor(pkg.relDir);
    if (normalize(clean) === normalize(canonicalClean)) {
      violations.push(
        `${name} is in CLEAN_ALLOWLIST but its clean already matches the canonical form ` +
          `(${JSON.stringify(canonicalClean)}). Remove the stale exemption so this guard protects the package.`
      );
    }
  }
  assert.deepEqual(violations, [], `Stale CLEAN_ALLOWLIST entries:\n${violations.join('\n')}`);
});

test('TYPE_CHECK_ALLOWLIST has no dead entries (each listed package actually diverges)', () => {
  const allowedForms = CANONICAL_TYPE_CHECK_FORMS.map(normalize);
  const violations = [];
  for (const [name] of TYPE_CHECK_ALLOWLIST) {
    const pkg = packagesByName.get(name);
    if (!pkg) {
      violations.push(
        `${name} is in TYPE_CHECK_ALLOWLIST but is not a workspace package (typo or removed?).`
      );
      continue;
    }
    const typeCheck = pkg.scripts['type-check'];
    if (typeCheck === undefined) {
      violations.push(
        `${name} is in TYPE_CHECK_ALLOWLIST but has no type-check script — there is nothing to exempt. Remove the entry.`
      );
      continue;
    }
    if (allowedForms.includes(normalize(typeCheck))) {
      violations.push(
        `${name} is in TYPE_CHECK_ALLOWLIST but its type-check already matches an allowed form. ` +
          'Remove the stale exemption so this guard protects the package.'
      );
    }
  }
  assert.deepEqual(violations, [], `Stale TYPE_CHECK_ALLOWLIST entries:\n${violations.join('\n')}`);
});

test('LINT_ALLOWLIST has no dead entries (each listed package actually diverges)', () => {
  const violations = [];
  for (const [name] of LINT_ALLOWLIST) {
    const pkg = packagesByName.get(name);
    if (!pkg) {
      violations.push(
        `${name} is in LINT_ALLOWLIST but is not a workspace package (typo or removed?).`
      );
      continue;
    }
    const lint = pkg.scripts.lint;
    if (lint === undefined) {
      violations.push(
        `${name} is in LINT_ALLOWLIST but has no lint script — there is nothing to exempt. Remove the entry.`
      );
      continue;
    }
    if (normalize(lint) === CANONICAL_LINT) {
      violations.push(
        `${name} is in LINT_ALLOWLIST but its lint already matches the canonical alias ` +
          `(${JSON.stringify(CANONICAL_LINT)}). Remove the stale exemption so this guard protects the package.`
      );
    }
  }
  assert.deepEqual(violations, [], `Stale LINT_ALLOWLIST entries:\n${violations.join('\n')}`);
});

test('workspace enumeration is not vacuous (every configured glob group still yields packages)', () => {
  // Every test above trusts `packages` to be a real, total enumeration. If
  // pnpm-workspace.yaml is ever reformatted (flow-style `packages: [...]`, a
  // renamed `packages:` key, etc.) in a way readWorkspaceGlobs() no longer
  // parses, every for-loop above would iterate zero times and pass VACUOUSLY —
  // the exact stale-green class this whole file exists to prevent.
  const configuredGroups = readWorkspaceGlobs();
  assert.ok(
    configuredGroups.length >= 3,
    `readWorkspaceGlobs() found only ${configuredGroups.length} package glob(s) in pnpm-workspace.yaml (expected ` +
      'at least 3: apps/*, packages/*, packages/config/*). This usually means the packages: block changed shape ' +
      '(flow-style array, renamed key, …) in a way the parser no longer recognizes. Fix readWorkspaceGlobs(), not ' +
      'this assertion.'
  );

  const groupsWithPackages = new Set(packages.map((pkg) => pkg.group));
  const emptyGroups = configuredGroups.filter((group) => !groupsWithPackages.has(group));
  assert.deepEqual(
    emptyGroups,
    [],
    `The following pnpm-workspace.yaml package glob(s) matched zero workspace packages: ${emptyGroups.join(', ')}. ` +
      'A configured glob yielding no packages usually means its directory was renamed or moved — e.g. ' +
      'packages/config/* owns exactly one package (@brainstrike/tsconfig), so losing that directory would ' +
      'otherwise go unnoticed by every other assertion in this file.'
  );

  assert.ok(
    packages.length >= 30,
    `Expected the workspace enumeration to find at least 30 packages but found ${packages.length}. A sudden drop ` +
      'usually means pnpm-workspace.yaml stopped parsing correctly rather than 10+ packages being legitimately ' +
      'removed at once.'
  );
});
