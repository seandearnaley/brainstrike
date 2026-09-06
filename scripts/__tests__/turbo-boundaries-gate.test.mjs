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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  gitIgnoredPaths,
  parseFindings,
  parseIssueCount,
  partitionFindings,
} from '../turbo-boundaries.mjs';

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
function writeFixture(
  dir,
  { generatedViolation = false, initGit = true, trackGenerated = false, violating }
) {
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
  if (initGit) {
    git(dir, ['init', '-q']);
    // The mirror of the no-git control: git must answer about THIS fixture and
    // not some repository above the temp dir, or `dist` would be classified
    // against the wrong .gitignore and the suppression tests would be testing
    // an unrelated tree.
    //
    // Compared through realpathSync on BOTH sides rather than as strings: Git
    // for Windows reports `--absolute-git-dir` with forward slashes, which
    // never equals a `path.join` result on win32, and realpath also settles
    // drive-letter case and any symlinked temp dir. Comparing the raw strings
    // would fail this control on a Windows workstation for a fixture git had
    // resolved perfectly correctly.
    const discovery = gitDiscovery(dir);
    const found = discovery.stdout.trim();
    assert.notEqual(
      found,
      '',
      `fixture control: git reported no git dir for the fixture: ${discovery.stderr.trim()}`
    );
    assert.equal(
      realpathSync(found),
      realpathSync(path.join(dir, '.git')),
      `fixture control: git resolved a repository outside the fixture: ${found}`
    );
  }
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

/**
 * Config every git call in this file runs under, at the highest precedence and
 * with no config FILE involved. `core.excludesFile` is the load-bearing one:
 * git reads `~/.config/git/ignore` BY DEFAULT, with no config entry needed, and
 * the gate's own docstring names that as the local-vs-CI difference. A personal
 * excludes file that happens to match a fixture path would silently reclassify
 * source as generated. The other two pin file content and branch naming so a
 * Windows or differently-configured runner builds the same fixture.
 */
function pinnedConfig(absentPath) {
  return [
    ['core.autocrlf', 'false'],
    ['core.excludesFile', absentPath],
    ['init.defaultBranch', 'main'],
  ];
}

/**
 * The environment that makes a fixture answer the same question everywhere.
 *
 * `git check-ignore` walks UP from its cwd hunting for a repository, so a
 * fixture built with `initGit: false` is only unclassifiable if no ANCESTOR of
 * `os.tmpdir()` is a repository either. That held on the machines this file was
 * written on and stopped holding in CI (BST-1376): with a repository anywhere
 * above the temp dir, check-ignore exits 1 ("nothing here is ignored") instead
 * of 128 ("no repository to ask"), the gate classifies every finding as source,
 * and the unclassifiable branch this file exists to cover is never reached —
 * the test then fails on an assertion, blaming the gate for an environment fact.
 *
 * `GIT_CEILING_DIRECTORIES` stops the upward walk at the fixture's PARENT, so
 * discovery can never leave the fixture: `initGit: false` means no repository,
 * on every host, whatever sits above the temp dir. The real path is what git
 * compares against, hence `realpathSync` (`/tmp` is a symlink on macOS).
 */
function gitEnv(cwd) {
  const absentPath = path.join(cwd, 'no-such-file-by-design');
  const pinned = pinnedConfig(absentPath);
  const env = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: path.dirname(realpathSync(cwd)),
    GIT_CONFIG_COUNT: String(pinned.length),
    GIT_CONFIG_GLOBAL: absentPath,
    GIT_CONFIG_NOSYSTEM: '1',
    // The stderr assertions below match git's English messages ("not a git
    // repository"); a gettext-localized git under a non-English LANG would
    // translate them and blame the gate for a locale fact. Same class as the
    // ceiling pin above, different env axis.
    LC_ALL: 'C',
  };
  for (const [index, [key, value]] of pinned.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return env;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(cwd) });
  assert.equal(result.error, undefined, `could not spawn git: ${result.error?.message}`);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

/**
 * What git makes of the fixture, asked directly rather than through the gate.
 * The tests use this as a SETUP control: it names the state the fixture was
 * supposed to manufacture, so an environment that produces a different one
 * fails while still describing itself instead of surfacing as a confusing
 * verdict from the gate several steps later.
 */
function gitDiscovery(cwd) {
  return spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(cwd),
  });
}

function runBoundaries(cwd) {
  // --skip-infer: the fixture must use THIS repo's turbo binary, not re-resolve
  // one from the fixture (which has no node_modules).
  const result = spawnSync(turboBin, ['boundaries', '--skip-infer'], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(cwd),
  });
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
    env: gitEnv(cwd),
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

test('when git cannot classify, the gate fails AND still hands back every finding', () => {
  // No repository to ask (a tarball export, a copied tree). Failing is right —
  // nothing is classifiable — but failing must not swallow the diagnostics the
  // developer has to act on, the way the parse-mismatch branch does not.
  withFixture('boundaries-nogit-', { initGit: false, violating: true }, (dir) => {
    // CONTROL, before the gate is asked anything: the fixture has to actually
    // BE unclassifiable. Git discovery walks upward, so "no .git here" is not
    // the same as "no repository" — see gitEnv() and BST-1376. If this ever
    // stops holding, the failure names the repository git found instead of
    // arriving later as a bare "the gate must say why it could not classify".
    const discovery = gitDiscovery(dir);
    assert.equal(
      discovery.status,
      128,
      'fixture control: this test needs a directory git refuses to treat as a repository, ' +
        `but git answered with ${discovery.stdout.trim() || '(no output)'} (exit ${discovery.status}). ` +
        'Discovery escaped the fixture — GIT_CEILING_DIRECTORIES in gitEnv() is what pins it.'
    );
    assert.match(
      discovery.stderr,
      /not a git repository/,
      `fixture control: git failed for some other reason than having no repository: ${discovery.stderr.trim()}`
    );

    const gate = runGate(dir);
    assert.notEqual(gate.status, 0, 'an unclassifiable run must fail');
    // The SPECIFIC condition, not merely "it failed somehow": exit 128 from
    // check-ignore is git saying there is no repository to ask. A gate that
    // failed for any other reason has not exercised this branch.
    assert.match(
      `${gate.stdout}\n${gate.stderr}`,
      /git check-ignore failed \(exit 128\)/,
      'the gate must say why it could not classify'
    );
    assert.match(
      `${gate.stdout}\n${gate.stderr}`,
      /not a git repository/,
      "the gate must pass through git's own reason, not just an exit code"
    );
    assert.match(
      gate.stderr,
      /undeclared-dep/,
      'turbo’s findings must survive a git failure, not be dropped on the floor'
    );
    assert.match(gate.stdout, /1 issue found/, "turbo's own summary must survive too");
  });
});

test('a stdin write that loses its reader does not erase git’s verdict', () => {
  // BST-1376, made deterministic. `git check-ignore` exits before reading a
  // byte of stdin when there is no repository, so the path list is written to a
  // pipe nobody is reading: a list small enough to fit the pipe buffer lands
  // harmlessly and git's exit 128 comes back intact, which is why developer
  // machines never saw this. A list too large to buffer must actually reach a
  // reader, so the write fails — and `spawnSync` then reports EPIPE ALONGSIDE
  // the child's real status. The gate used to read `error` first and blame the
  // spawn, reporting "could not run git check-ignore" for a git that ran and
  // answered; CI hit that branch twice on runs whose diffs touched no scripts/.
  withFixture('boundaries-epipe-', { initGit: false, violating: false }, (dir) => {
    const many = Array.from({ length: 12_000 }, (_, index) =>
      path.join(dir, 'packages', 'alpha', 'dist', `chunk-${index}.js`)
    );
    // CONTROL: this test is only exercising the race while the payload cannot
    // fit a pipe buffer. If paths ever get short enough for it to fit, this
    // fails here rather than passing for the wrong reason.
    const payloadBytes = many.join('\0').length + 1;
    assert.ok(
      payloadBytes > 512 * 1024,
      `control: the path list must exceed any plausible pipe buffer; got ${payloadBytes} bytes`
    );

    // gitIgnoredPaths spawns git with the ambient environment, so the ceiling
    // has to be on the environment itself for the fixture to stay repo-less.
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    const previousLocale = process.env.LC_ALL;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(realpathSync(dir));
    // Same locale pin as gitEnv(): the assertion matches English git stderr.
    process.env.LC_ALL = 'C';
    try {
      assert.throws(
        () => gitIgnoredPaths(many, dir),
        /git check-ignore failed \(exit 128\)[\s\S]*not a git repository/,
        "git's own exit status and reason must survive a stdin write error"
      );
    } finally {
      if (previousCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      }
      if (previousLocale === undefined) {
        delete process.env.LC_ALL;
      } else {
        process.env.LC_ALL = previousLocale;
      }
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
  // Two files NAME the directive in prose instead of carrying one: this test,
  // which explains what it enforces, and the gate script, whose header records
  // that `turbo boundaries --ignore` would write these comments into scanned
  // files. Exempt exactly those files, never the directories they live in.
  const prosePaths = [
    'scripts/__tests__/turbo-boundaries-gate.test.mjs:',
    'scripts/turbo-boundaries.mjs:',
  ];
  // An exemption that stops matching is an exemption nobody is auditing — if
  // the prose is reworded away, delete the entry rather than leaving it.
  for (const prosePath of prosePaths) {
    assert.ok(
      lines.some((line) => line.startsWith(prosePath)),
      `${prosePath} no longer mentions @boundaries-ignore — drop it from prosePaths`
    );
  }
  const annotations = lines.filter(
    (line) => !prosePaths.some((prosePath) => line.startsWith(prosePath))
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
