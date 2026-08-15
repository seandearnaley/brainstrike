/**
 * Contract tests for the package-boundary gate (BST-967).
 *
 * The gate is a Static-job step, `pnpm run boundaries` →
 * `scripts/turbo-boundaries.mjs`, ordered BEFORE any step that can materialize
 * `dist/` (type-check's dependsOn: ["build"] builds the workspace; a replayed
 * turbo cache task writes outputs back).
 *
 * TWO THINGS ARE UNDER CONTRACT HERE.
 *
 * 1. The gate can fail. Per the BST-836 discipline: a minimal fixture
 *    workspace with an undeclared import must exit non-zero, and the same
 *    fixture without the violation must exit zero. A gate that cannot fail is
 *    not evidence.
 *
 * 2. The gate is idempotent. `turbo boundaries` scans build output as well as
 *    source and has no exclusion mechanism at any level — no CLI flag, no
 *    `turbo.json` key, no `.turboignore`, and it does not consult `.gitignore`
 *    (checked against 2.10.8, 2.10.10, and 2.10.11-canary.3). So the raw
 *    command reports phantom violations against generated bundles the moment a
 *    build has run: green on a clean checkout, red on the identical tree after
 *    `pnpm build`, over files nobody wrote (observed live: the unmerged turso
 *    branch's `dist/turso/*` flagged `@tursodatabase/database` imports that no
 *    source on main contains; and `apps/web/dist/assets/chunking.worker-*.ts`
 *    flagged for `@brainstrike/tokenization`). The wrapper judges only findings
 *    in files git does not ignore, which is why the ordering above is now a
 *    scan-cost property rather than the thing keeping the gate honest.
 *
 * The tests below hold both ends: generated output cannot fail the gate, and
 * generated output cannot MASK a source violation either.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parseFindings, parseIssueCount, partitionFindings } from '../turbo-boundaries.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const turboBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'turbo.cmd' : 'turbo'
);
const gateScript = path.join(repoRoot, 'scripts', 'turbo-boundaries.mjs');

const UNDECLARED_IMPORT = "import { thing } from 'undeclared-dep';\nexport const x = thing;\n";

/**
 * A one-package workspace, optionally with a violation in source, in generated
 * output, or both. `dist/` is git-ignored exactly as it is in this repo — the
 * fixture is a git repository because that is what the gate asks about.
 */
function writeFixture(dir, { generatedViolation = false, trackGenerated = false, violating }) {
  mkdirSync(path.join(dir, 'packages', 'alpha', 'src'), { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'boundaries-fixture', packageManager: 'pnpm@11.15.0', private: true })
  );
  writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  writeFileSync(path.join(dir, '.gitignore'), 'dist\n');
  writeFileSync(
    path.join(dir, 'turbo.json'),
    JSON.stringify({
      $schema: 'https://turborepo.dev/schema.json',
      tasks: { build: { outputs: ['dist/**'] } },
    })
  );
  writeFileSync(
    path.join(dir, 'packages', 'alpha', 'package.json'),
    JSON.stringify({ name: 'alpha', private: true, version: '0.0.0' })
  );
  writeFileSync(
    path.join(dir, 'packages', 'alpha', 'src', 'index.ts'),
    violating ? UNDECLARED_IMPORT : 'export const x = 1;\n'
  );
  git(dir, ['init', '-q']);
  if (!generatedViolation) {
    return;
  }
  mkdirSync(path.join(dir, 'packages', 'alpha', 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'packages', 'alpha', 'dist', 'index.js'), UNDECLARED_IMPORT);
  if (trackGenerated) {
    // -f overrides .gitignore: this is the "someone committed it" case, where
    // the file IS part of the repository and the gate must still judge it.
    git(dir, ['add', '-f', 'packages/alpha/dist/index.js']);
  }
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.error, undefined, `could not spawn git: ${result.error?.message}`);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

function runBoundaries(cwd) {
  // --skip-infer: the fixture must use THIS repo's turbo binary, not re-resolve
  // one from the fixture (which has no node_modules).
  const result = spawnSync(turboBin, ['boundaries', '--skip-infer'], { cwd, encoding: 'utf8' });
  // A spawn failure yields status null, which would satisfy notEqual(status, 0)
  // and turn the MONEY TEST vacuous. Fail here, with the real reason.
  assert.equal(result.error, undefined, `could not spawn ${turboBin}: ${result.error?.message}`);
  return result;
}

/** The gate as Static runs it: the wrapper, over the fixture workspace. */
function runGate(cwd) {
  const result = spawnSync(process.execPath, [gateScript, '--skip-infer'], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, `could not spawn ${gateScript}: ${result.error?.message}`);
  assert.notEqual(
    result.status,
    null,
    `${gateScript} did not exit normally: ${result.stdout}\n${result.stderr}`
  );
  return result;
}

function withFixture(prefix, options, assertions) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    writeFixture(dir, options);
    assertions(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test('MONEY TEST: a fixture workspace with an undeclared import FAILS the gate (exit != 0)', () => {
  withFixture('boundaries-money-', { violating: true }, (dir) => {
    const raw = runBoundaries(dir);
    assert.notEqual(
      raw.status,
      0,
      `boundaries must exit non-zero on a violation; got ${raw.status}\n${raw.stdout}\n${raw.stderr}`
    );
    assert.match(`${raw.stdout}\n${raw.stderr}`, /issue/i, 'boundaries should report the issue');

    const gate = runGate(dir);
    assert.notEqual(
      gate.status,
      0,
      `the gate must exit non-zero on a source violation; got ${gate.status}\n${gate.stdout}\n${gate.stderr}`
    );
    assert.match(
      `${gate.stdout}\n${gate.stderr}`,
      /undeclared-dep/,
      'the gate must report the offending import, not just a count'
    );
  });
});

test('control: the same fixture without the violation passes the gate (exit 0)', () => {
  withFixture('boundaries-clean-', { violating: false }, (dir) => {
    const raw = runBoundaries(dir);
    assert.equal(
      raw.status,
      0,
      `boundaries must exit 0 on a clean tree; got ${raw.status}\n${raw.stdout}\n${raw.stderr}`
    );
    const gate = runGate(dir);
    assert.equal(
      gate.status,
      0,
      `the gate must exit 0 on a clean tree; got ${gate.status}\n${gate.stdout}\n${gate.stderr}`
    );
  });
});

test('MONEY TEST: a violation that exists ONLY in git-ignored build output passes the gate', () => {
  withFixture('boundaries-generated-', { generatedViolation: true, violating: false }, (dir) => {
    // The control is the whole point: raw `turbo boundaries` FAILS on this
    // tree. Without it this test could pass because the fixture is empty
    // rather than because the wrapper scoped the verdict — which is exactly
    // the non-idempotent `pnpm check` this gate had.
    const raw = runBoundaries(dir);
    assert.notEqual(
      raw.status,
      0,
      'raw `turbo boundaries` is expected to flag build output — if it no longer does, delete the wrapper instead of this test'
    );
    assert.match(raw.stderr, /dist/, 'the raw finding must be the dist file');

    const gate = runGate(dir);
    assert.equal(
      gate.status,
      0,
      `generated output must not fail the gate; got ${gate.status}\n${gate.stdout}\n${gate.stderr}`
    );
    assert.match(
      gate.stdout,
      /Ignored 1 finding in generated output/,
      'the gate must say what it ignored rather than silently passing'
    );
  });
});

test('MONEY TEST: build output cannot MASK a source violation', () => {
  withFixture('boundaries-mixed-', { generatedViolation: true, violating: true }, (dir) => {
    const gate = runGate(dir);
    assert.notEqual(gate.status, 0, 'a source violation must still fail with dist present');
    assert.match(gate.stdout, /1 source boundary violation\b/);
    // The diagnostics stream carries exactly the findings being reported, so
    // these two assertions are about what the gate blames — not about text
    // that happens to appear somewhere in the combined output.
    assert.match(gate.stderr, /src[\\/]index\.ts/, 'the source finding must be shown');
    assert.doesNotMatch(
      gate.stderr,
      /dist[\\/]index\.js/,
      'the generated finding must not be reprinted as a violation'
    );
  });
});

test('a TRACKED file under dist/ is still judged — the rule is git, not the directory name', () => {
  withFixture(
    'boundaries-tracked-',
    { generatedViolation: true, trackGenerated: true, violating: false },
    (dir) => {
      const gate = runGate(dir);
      assert.notEqual(
        gate.status,
        0,
        `a committed file is part of the repository and must be judged; got ${gate.status}\n${gate.stdout}\n${gate.stderr}`
      );
      assert.match(`${gate.stdout}\n${gate.stderr}`, /1 source boundary violation\b/);
    }
  );
});

test('the parser accounts for every issue turbo reports (a mismatch fails the gate unfiltered)', () => {
  withFixture('boundaries-parse-', { generatedViolation: true, violating: true }, (dir) => {
    const raw = runBoundaries(dir);
    const issueCount = parseIssueCount(raw.stdout);
    assert.equal(issueCount, 2, `expected 2 issues from the fixture, got ${issueCount}`);
    const { findings } = parseFindings(raw.stderr);
    assert.equal(
      findings.length,
      issueCount,
      'the diagnostic parser must keep up with turbo output format; the gate refuses to filter when these disagree'
    );
    for (const finding of findings) {
      assert.equal(finding.paths.length, 1, `each finding should carry its file: ${finding.text}`);
    }
  });
});

test('a finding with no file location is never suppressed', () => {
  // Tag-rule and cycle diagnostics need not point at a file. Unclassifiable is
  // not the same as clean — NO SILENT FALLBACKS.
  const { generated, source } = partitionFindings(
    [
      { paths: [], text: '  x boundaries rules cannot have `tags` key' },
      { paths: ['/repo/packages/alpha/dist/index.js'], text: '  x generated' },
    ],
    new Set(['/repo/packages/alpha/dist/index.js'])
  );
  assert.equal(source.length, 1);
  assert.match(source[0].text, /tags/);
  assert.equal(generated.length, 1);
});

test('the Static job runs boundaries BEFORE any step that can materialize dist/', () => {
  const workflow = parseYaml(
    readFileSync(path.join(repoRoot, '.github/workflows/test.yml'), 'utf8')
  );
  const steps = workflow?.jobs?.static?.steps;
  assert.ok(Array.isArray(steps), 'test.yml must have a static job with steps');

  const runs = steps.map((step) => step.run ?? '');
  // The gate is the wrapper, not the bare subcommand — Static must not go back
  // to `turbo boundaries` directly, which cannot tell source from build output.
  const boundariesIndex = runs.findIndex((run) => /\bpnpm run boundaries\b/.test(run));
  assert.notEqual(boundariesIndex, -1, 'Static must run `pnpm run boundaries` (BST-967)');
  assert.deepEqual(
    runs.filter((run) => /(?:^|\s)(?:pnpm\s+exec\s+)?turbo\s+boundaries\b/.test(run)),
    [],
    'Static must go through scripts/turbo-boundaries.mjs, not raw `turbo boundaries`'
  );

  // Any step invoking the turbo task graph (type-check depends on build) or a
  // package build can write dist/. That no longer produces phantom violations
  // (the wrapper scopes the verdict to source), but a clean tree is roughly
  // half the files to scan, so the ordering is still worth holding.
  // Word-boundary `build` also catches `pnpm build`, `pnpm build:web`,
  // `turbo build`, and `pnpm check` idioms (check.mjs runs the full build via
  // its `build` step name — the token appears in the command either way).
  // Known blind spot: `uses:` steps are invisible here (runs is built from
  // step.run). Today's composite only restores the `.turbo` tarball cache,
  // which boundaries cannot parse; a future action restoring real build
  // outputs would slip past this assertion — keep dist-producing work in
  // `run:` steps or extend this test.
  const distProducingIndex = runs.findIndex((run) =>
    /\b(build|type-check)\b|turbo\s+run/.test(run)
  );
  assert.ok(
    distProducingIndex === -1 || boundariesIndex < distProducingIndex,
    `boundaries (step ${boundariesIndex}) must run before dist-producing steps (first at ${distProducingIndex})`
  );
});

test('every @boundaries-ignore in the repo carries a reason', () => {
  const grep = spawnSync(
    'git',
    [
      'grep',
      '-n',
      '@boundaries-ignore',
      '--',
      '*.ts',
      '*.tsx',
      '*.mts',
      '*.cts',
      '*.js',
      '*.jsx',
      '*.mjs',
      '*.cjs',
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  // git grep exits 1 on zero matches, which would make this test vacuous the
  // day the last ignore disappears — that is fine (nothing left to justify),
  // but a real error (exit > 1) must surface.
  assert.ok(grep.status === 0 || grep.status === 1, grep.stderr);
  const lines = grep.stdout.split('\n').filter(Boolean);
  // This test file mentions the directive in prose; exempt exactly this file,
  // not the whole scripts/__tests__ directory.
  const annotations = lines.filter(
    (line) => !line.startsWith('scripts/__tests__/turbo-boundaries-gate.test.mjs:')
  );
  for (const line of annotations) {
    const reason = line.split('@boundaries-ignore')[1]?.trim() ?? '';
    assert.ok(
      reason.length >= 20,
      `@boundaries-ignore must carry a substantive reason (>=20 chars): ${line}`
    );
  }
  // Anti-vacuous floor: the seven sanctioned crossings (five from #2101, plus
  // file-import/src/resolve-chunking-worker-url.ts, plus chunking-worker's
  // tree-sitter bench reaching text-splitter SOURCE — reported once Turbo
  // 2.10.8 widened the analyzer) exist today.
  // If this number legitimately drops, update it alongside the removal.
  assert.ok(
    annotations.length >= 7,
    `expected at least 7 annotated crossings, found ${annotations.length} — did a sweep remove reasons?`
  );
});

// In CI the workflow's own `Package boundaries` step (fresh checkout, no dist)
// IS this verdict; re-scanning the repo here would only pay for a second full
// analysis to assert nothing. The value is local, on a tree that HAS been
// built: the idempotency claim measured against the real repo rather than a
// fixture — hence skip-in-CI.
test('the gate reaches the same verdict on this working tree as on a clean checkout', {
  skip: Boolean(process.env.CI),
}, () => {
  const gate = runGate(repoRoot);
  assert.equal(
    gate.status,
    0,
    `source-side boundary violations found (the gate would fail CI):\n${gate.stdout}\n${gate.stderr}`
  );
});
