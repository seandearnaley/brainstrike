// BST-836: every `scripts/verify-*.mjs` must fail loudly when run directly.
//
// Four of these scripts shipped as pure LIBRARIES — exported helpers with no
// `main()` invocation. `node scripts/verify-catalog-references.mjs` therefore
// exited 0 unconditionally: it loaded the module, defined some functions, and
// terminated without checking anything. Control-tested at the time by injecting
// `"typescript": "6.0.3"` into packages/commands/package.json — a real drift the
// guard is built to catch — direct execution still exited 0.
//
// Enforcement was never actually missing (each guard's paired test or owning
// lint command asserts the real-repo verdict in CI's Static job). The damage
// was evidentiary: a green from a script that cannot go red reads exactly like
// a green from one that can, and it got cited as proof in a PR body.
//
// This file guards the ENTRYPOINT CONTRACT, not any individual guard's detection
// logic — its paired test or owning lint command owns that. Two properties:
//   1. the script actually runs its check when executed directly, and
//   2. that run can reach a non-zero exit.
//
// Property 2 is the one that matters. A `main() {}` no-op satisfies property 1's
// static shape while reproducing the exact bug, so the test drives each `main()`
// against a root where no guard can honestly pass and asserts it refuses to
// report success.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// Full-repository verdicts belong to each guard's paired test or lint command,
// not to this wiring test. Expensive entrypoints opt into a bounded invalid
// root here as they gain a supported CLI fixture interface.
const BOUNDED_ENTRYPOINT_ARGS = new Map([
  [
    'verify-eslint-warning-baselines.mjs',
    {
      args: (root) => ['--repo-root', root],
      failureSignature: (root) => path.join(root, 'eslint-warning-baseline.json'),
    },
  ],
  [
    'verify-no-source-cycles.mjs',
    {
      args: (root) => ['--repo-root', root],
      failureSignature: (root) => root,
    },
  ],
  [
    'verify-private-test-input-locality.mjs',
    {
      args: (root) => ['--repo-root', root],
      failureSignature: (root) => root,
    },
  ],
  [
    'verify-workspace-src-aliases.mjs',
    {
      args: (root) => ['--repo-root', root],
      failureSignature: (root) => path.join(root, 'packages'),
    },
  ],
]);

function probeEntrypoint({ args = [], failureSignature, name, scriptPath }) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const spawnSucceeded = result.error === undefined;
  return {
    boundedControlPassed:
      spawnSucceeded &&
      (failureSignature === undefined ||
        (Number.isInteger(result.status) &&
          result.status !== 0 &&
          output.includes(failureSignature))),
    hasOutput: spawnSucceeded && output.trim() !== '',
    name,
  };
}

test('discovery floor: the verify-* script set is not silently empty', () => {
  assert.ok(
    VERIFY_SCRIPTS.length >= MIN_VERIFY_SCRIPTS,
    `Found only ${VERIFY_SCRIPTS.length} verify-* script(s) in scripts/, below the floor of ` +
      `${MIN_VERIFY_SCRIPTS}. Either guards were deleted (restore them) or discovery broke, in ` +
      'which case every assertion in this file is vacuously green.'
  );
  assert.deepEqual(
    [...BOUNDED_ENTRYPOINT_ARGS.keys()].filter((name) => !VERIFY_SCRIPTS.includes(name)),
    [],
    'Bounded entrypoint controls must name discovered verify-* scripts'
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

test('executable probe rejects broken entrypoint controls', (t) => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'verify-entrypoint-controls-'));
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));

  const expectedFailure = path.join(fixtureRoot, 'expected-missing-input.json');
  const directExecution = `
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
`;
  const fixtures = [
    {
      name: 'no-op-main',
      source: `${directExecution}\nfunction main() {}\nif (isDirectExecution) main();\n`,
    },
    {
      name: 'wrong-direct-execution-predicate',
      source: `if (process.argv[1] === import.meta.url) { console.error('ran'); process.exitCode = 1; }\n`,
    },
    {
      name: 'ignored-fixture-root',
      source: `${directExecution}\nif (isDirectExecution) { console.error('checked default root'); process.exitCode = 1; }\n`,
    },
    {
      name: 'lost-nonzero-exit',
      source: `${directExecution}\nif (isDirectExecution) console.error(${JSON.stringify(expectedFailure)});\n`,
    },
  ];

  const falseGreens = [];
  for (const fixture of fixtures) {
    const scriptPath = path.join(fixtureRoot, `${fixture.name}.mjs`);
    writeFileSync(scriptPath, fixture.source);
    const probe = probeEntrypoint({
      args: ['--repo-root', fixtureRoot],
      failureSignature: expectedFailure,
      name: fixture.name,
      scriptPath,
    });
    if (probe.hasOutput && probe.boundedControlPassed) {
      falseGreens.push(fixture.name);
    }
  }

  assert.deepEqual(
    falseGreens,
    [],
    'The entrypoint probe accepted broken executable controls:\n' +
      falseGreens.map((name) => `  - ${name}`).join('\n')
  );
});

// The in-process test below imports main() directly, so it cannot see whether
// the `isDirectExecution` predicate actually fires — a subtly wrong copy of the
// idiom (comparing an unresolved argv[1] against a realpath-resolved
// import.meta.url, say) silently restores the original bug.
//
// Unbounded entrypoints assert only that SOMETHING was reported: a guard
// legitimately failing on a dirty tree is its owning verdict's business, and
// duplicating that verdict here would surface unrelated violations as confusing
// entrypoint failures. Bounded controls additionally require their fixture's
// exact failure signature and a nonzero exit.
test('direct execution reaches the check and bounded controls fail', (t) => {
  const bogusRoot = mkdtempSync(path.join(os.tmpdir(), 'verify-entrypoint-root-'));
  t.after(() => rmSync(bogusRoot, { force: true, recursive: true }));

  const silent = [];
  const fixtureRootsIgnored = [];
  for (const name of VERIFY_SCRIPTS) {
    const boundedEntrypoint = BOUNDED_ENTRYPOINT_ARGS.get(name);
    const boundedArgs = boundedEntrypoint?.args(bogusRoot) ?? [];
    const probe = probeEntrypoint({
      args: boundedArgs,
      failureSignature: boundedEntrypoint?.failureSignature(bogusRoot),
      name,
      scriptPath: path.join(SCRIPTS_DIR, name),
    });
    if (!probe.hasOutput) {
      silent.push(name);
    }
    if (!probe.boundedControlPassed) {
      fixtureRootsIgnored.push(name);
    }
  }

  assert.deepEqual(
    silent,
    [],
    'These scripts produced no output at all when spawned directly, so their ' +
      'direct-execution predicate never fired — the BST-836 bug, restored:\n' +
      silent.map((name) => `  - scripts/${name}`).join('\n')
  );
  assert.deepEqual(
    fixtureRootsIgnored,
    [],
    'These scripts reported success against their explicit invalid fixture root. ' +
      'The CLI either ignored the fixture argument or lost the nonzero exit status:\n' +
      fixtureRootsIgnored.map((name) => `  - scripts/${name}`).join('\n')
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
