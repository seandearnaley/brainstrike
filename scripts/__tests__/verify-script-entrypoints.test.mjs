// BST-836: every `scripts/verify-*.mjs` must fail loudly when run directly.
//
// Four of these scripts shipped as pure LIBRARIES — exported helpers with no
// `main()` invocation. `node scripts/verify-catalog-references.mjs` therefore
// exited 0 unconditionally: it loaded the module, defined some functions, and
// terminated without checking anything. Control-tested at the time by injecting
// `"typescript": "6.0.3"` into packages/commands/package.json — a real drift the
// guard is built to catch — direct execution still exited 0.
//
// Enforcement was never actually missing (each paired test asserts the real-repo
// verdict under `pnpm test:scripts`, which CI's Static job runs). The damage was
// evidentiary: a green from a script that cannot go red reads exactly like a
// green from one that can, and it got cited as proof in a PR body.
//
// This file guards the ENTRYPOINT CONTRACT, not any individual guard's detection
// logic — each script's own paired test owns that. Two properties:
//   1. the script actually runs its check when executed directly, and
//   2. that run can reach a non-zero exit.
//
// Property 2 is the one that matters. A `main() {}` no-op satisfies property 1's
// static shape while reproducing the exact bug, so the test drives each `main()`
// against a root where no guard can honestly pass and asserts it refuses to
// report success.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Anti-vacuous-green floor, in the style of MIN_CATALOG_ENTRIES in
// verify-catalog-references.mjs: if discovery silently returns nothing, every
// assertion below passes while checking zero scripts.
const MIN_VERIFY_SCRIPTS = 8;

// Both entrypoint idioms used in this repo. A grep for only the `pathToFileURL`
// form falsely clears the scripts that use the `process.argv[1]` form — that
// narrow match is what made this class hard to spot by hand in the first place.
const DIRECT_EXECUTION_IDIOMS = [/process\.argv\[1\]/, /import\.meta\.main/];

// Discovered, not hand-listed: a new guard added tomorrow is covered the moment
// it lands, which a literal array would not do.
const VERIFY_SCRIPTS = readdirSync(SCRIPTS_DIR)
  .filter((name) => /^verify-.+\.mjs$/.test(name))
  .sort();

test('discovery floor: the verify-* script set is not silently empty', () => {
  assert.ok(
    VERIFY_SCRIPTS.length >= MIN_VERIFY_SCRIPTS,
    `Found only ${VERIFY_SCRIPTS.length} verify-* script(s) in scripts/, below the floor of ` +
      `${MIN_VERIFY_SCRIPTS}. Either guards were deleted (restore them) or discovery broke, in ` +
      'which case every assertion in this file is vacuously green.'
  );
});

test('every verify-* script invokes its check on direct execution', () => {
  const libraries = VERIFY_SCRIPTS.filter((name) => {
    const source = readFileSync(path.join(SCRIPTS_DIR, name), 'utf8');
    return !DIRECT_EXECUTION_IDIOMS.some((idiom) => idiom.test(source));
  });

  assert.deepEqual(
    libraries,
    [],
    'These scripts are named verify-* but run nothing when executed directly, so ' +
      '`node scripts/<name>` exits 0 no matter what the repo looks like:\n' +
      libraries.map((name) => `  - scripts/${name}`).join('\n')
  );
});

// The in-process test below imports main() directly, so it cannot see whether
// the `isDirectExecution` predicate actually fires — a subtly wrong copy of the
// idiom (comparing an unresolved argv[1] against a realpath-resolved
// import.meta.url, say) silently restores the original bug.
//
// This asserts only that SOMETHING was reported, deliberately not the exit code:
// a guard legitimately failing on a dirty tree is its paired test's business, and
// duplicating that verdict here would make an unrelated violation surface as a
// confusing "entrypoint" failure. Zero output is the signal that the wiring never
// ran at all.
test('direct execution actually reaches the check (the entrypoint predicate fires)', () => {
  const silent = [];
  for (const name of VERIFY_SCRIPTS) {
    const result = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, name)], {
      encoding: 'utf8',
    });
    if (`${result.stdout}${result.stderr}`.trim() === '') {
      silent.push(name);
    }
  }

  assert.deepEqual(
    silent,
    [],
    'These scripts produced no output at all when spawned directly, so their ' +
      'direct-execution predicate never fired — the BST-836 bug, restored:\n' +
      silent.map((name) => `  - scripts/${name}`).join('\n')
  );
});

test('MONEY TEST: each main() refuses to report success on a root it cannot verify', async () => {
  const bogusRoot = mkdtempSync(path.join(os.tmpdir(), 'bst836-empty-root-'));
  const previousExitCode = process.exitCode;
  const silentlyPassed = [];

  try {
    for (const name of VERIFY_SCRIPTS) {
      const { main } = await import(path.join(SCRIPTS_DIR, name));
      assert.equal(
        typeof main,
        'function',
        `scripts/${name} does not export main(), so its entrypoint cannot be control-tested here.`
      );

      process.exitCode = 0;
      let threw = false;
      try {
        // A generic bag, not a single key: most of these guards check the repo
        // tree, but verify-tokenizer-asset-bundle and verify-no-cross-chunk-cycles
        // check a build artifact and take a bundle `directory`. Supplying both
        // keeps the control uniform — every guard is pointed at the same empty
        // tree — without pretending the two kinds of guard share one root concept.
        await main({ directory: bogusRoot, repoRoot: bogusRoot });
      } catch {
        // A throw is a legitimate refusal: an uncaught error out of main() exits
        // non-zero, which is the property under test.
        threw = true;
      }
      if (!(threw || process.exitCode !== 0)) {
        silentlyPassed.push(name);
      }
    }
  } finally {
    process.exitCode = previousExitCode;
  }

  assert.deepEqual(
    silentlyPassed,
    [],
    'These scripts reported success against an empty directory — a tree where no ' +
      'guard can honestly pass. A main() that cannot go red is the BST-836 bug:\n' +
      silentlyPassed.map((name) => `  - scripts/${name}`).join('\n')
  );
});
