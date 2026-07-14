import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Guards the canonical shape of the per-package `clean` and `type-check` scripts
 * that Series B1 (PR #1650) collapsed behind shared forms. ~20 manifests were
 * normalized so the build graph reads one predictable command per script; this
 * contract stops them from silently drifting back into bespoke shapes.
 *
 * Canonical forms:
 *   clean        →  node ../../scripts/rimraf.mjs dist .tsbuildinfo
 *   type-check   →  tsc --noEmit
 *              or   tsc --noEmit && tsc --noEmit --project tsconfig.test.json
 *
 * The contract governs SHAPE, not PRESENCE: a package that omits a script is not
 * required to add one (many packages legitimately have no clean/type-check), but
 * any script that IS present must match the canonical form unless the owning
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

const CANONICAL_CLEAN = 'node ../../scripts/rimraf.mjs dist .tsbuildinfo';
const CANONICAL_TYPE_CHECK_FORMS = [
  'tsc --noEmit',
  'tsc --noEmit && tsc --noEmit --project tsconfig.test.json',
];

/**
 * Packages whose `clean` legitimately diverges from the canonical rimraf form.
 * name → documented reason.
 */
const CLEAN_ALLOWLIST = new Map([
  [
    '@brainstrike/ui',
    'prepends `pnpm run clean:generated` to drop generated sources before the shared rimraf pass',
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
    '@brainstrike/web',
    'app — `tsc --build --force` primes referenced-project outputs before the --noEmit passes',
  ],
  [
    '@brainstrike/desktop',
    'app — splits main + e2e type-checks via `pnpm type-check:main && pnpm type-check:e2e`',
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

/** Absolute dirs of every workspace package (a dir with a package.json). */
function workspacePackageDirs() {
  const dirs = new Set();
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
          dirs.add(dir);
        }
      } catch {
        // not a package dir
      }
    }
  }
  return [...dirs];
}

const packages = workspacePackageDirs().map((dir) => {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return {
    dir,
    name: manifest.name,
    relDir: path.relative(repoRoot, dir),
    scripts: manifest.scripts ?? {},
  };
});
const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));

test('every package clean script matches the canonical rimraf form', () => {
  const violations = [];
  for (const pkg of packages) {
    const clean = pkg.scripts.clean;
    if (clean === undefined || CLEAN_ALLOWLIST.has(pkg.name)) {
      continue;
    }
    if (normalize(clean) !== normalize(CANONICAL_CLEAN)) {
      violations.push(
        `${pkg.relDir} (${pkg.name}) has clean = ${JSON.stringify(clean)}, but the canonical form is ` +
          `${JSON.stringify(CANONICAL_CLEAN)}. Restore the canonical form, or — if this package legitimately ` +
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
    if (normalize(clean) === normalize(CANONICAL_CLEAN)) {
      violations.push(
        `${name} is in CLEAN_ALLOWLIST but its clean already matches the canonical form ` +
          `(${JSON.stringify(CANONICAL_CLEAN)}). Remove the stale exemption so this guard protects the package.`
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
