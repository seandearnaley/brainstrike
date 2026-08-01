// BST-1010 (R09): paired test for the E2E lane-coverage contract.
//
// Two halves, and the second is the load-bearing one:
//
//   1. The real-repo verdict — every spec in apps/web and apps/desktop is
//      reachable from a lane CI actually invokes.
//   2. The MONEY TEST — the same checker driven against a synthetic repo that
//      contains a hand-planted orphan tag and orphan spec, asserting a NON-ZERO
//      exit. BST-836 documented four `verify-*.mjs` guards that were pure
//      libraries: `node scripts/verify-X.mjs` exited 0 on a real violation, so
//      the green was indistinguishable from a real one. A guard nobody has
//      watched go red is not evidence, so this file watches it go red against a
//      fixture whose violations are known by construction.
//
// The fixture is a full miniature repo (app manifests + specs + workflow) rather
// than a stubbed module graph, so it exercises the same parse -> model -> report
// path as the real run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { analyzeE2eLaneCoverage, main } from '../e2e-lane-coverage.mjs';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const GUARD = path.join(SCRIPTS_DIR, 'e2e-lane-coverage.mjs');

const temporaryRoots = [];
after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

const LANE_FLAGS =
  '--workers=1 --retries=0 --max-failures=1 --global-timeout=600000 --project=functional';

/**
 * A miniature repo shaped exactly like the real one: two app manifests with
 * `test:e2e:lane:*` scripts, a workflow that invokes them, and specs under
 * `e2e/`. `webExtras` injects the violations under test.
 */
function createFixtureRepo({ webExtras = {}, webLanes = {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bst1010-lane-fixture-'));
  temporaryRoots.push(root);

  const lanes = {
    'test:e2e:lane:covered': `pnpm exec playwright test e2e/covered.test.ts ${LANE_FLAGS} --grep "@web-covered"`,
    'test:e2e:lane:full-regression': `pnpm exec playwright test ${LANE_FLAGS} --workers=2 --grep-invert "@destructive|@stateful" && pnpm run test:e2e:lane:covered`,
    ...webLanes,
  };

  write(
    root,
    'apps/web/package.json',
    JSON.stringify({ name: '@brainstrike/web', scripts: lanes }, null, 2)
  );
  write(
    root,
    'apps/desktop/package.json',
    JSON.stringify(
      {
        name: '@brainstrike/desktop',
        scripts: {
          'test:e2e:lane:full-regression': 'pnpm exec playwright test --project=regression',
        },
      },
      null,
      2
    )
  );
  write(
    root,
    '.github/workflows/web-e2e.yml',
    [
      'name: Web E2E',
      'jobs:',
      '  web-full-regression:',
      '    steps:',
      '      - name: Run full web regression',
      '        run: pnpm --filter @brainstrike/web run test:e2e:lane:full-regression',
      '  desktop-full-regression:',
      '    steps:',
      '      - name: Run desktop regression',
      '        working-directory: apps/desktop',
      '        run: pnpm run test:e2e:lane:full-regression',
      '',
    ].join('\n')
  );

  // Reachable via the broad pass (untagged), reachable via a lane grep, and a
  // desktop spec so the desktop half of the sweep is not empty.
  write(root, 'apps/web/e2e/broad.test.ts', "test('plain flow', async () => {});\n");
  write(
    root,
    'apps/web/e2e/covered.test.ts',
    "test.describe('Covered @stateful @web-covered', () => {\n  test('flow', async () => {});\n});\n"
  );
  write(root, 'apps/desktop/e2e/desktop.test.ts', "test('desktop flow', async () => {});\n");

  for (const [relativePath, contents] of Object.entries(webExtras)) {
    write(root, relativePath, contents);
  }
  return root;
}

// The fixture is deliberately smaller than the real repo, so the production
// floors would reject it. Analysing it with floors of 1 keeps the fixture legible
// while leaving the real floors doing their job in the real run.
const FIXTURE_MINIMUMS = {
  desktop: { lanes: 1, laneTags: 0, specs: 1 },
  web: { lanes: 1, laneTags: 1, specs: 2 },
};

function analyzeFixture(root, knownUnreachableSpecs = {}) {
  return analyzeE2eLaneCoverage({
    knownUnreachableSpecs,
    minimums: FIXTURE_MINIMUMS,
    repoRoot: root,
  });
}

function kinds(report) {
  return report.violations.map((violation) => violation.kind).sort();
}

test('control: a fixture with every spec wired into a lane reports no violations', async () => {
  const report = await analyzeFixture(createFixtureRepo());
  assert.deepEqual(report.violations, []);
  // Without this the "clean fixture" could be clean because nothing was found.
  assert.ok(
    report.apps.some((app) => app.app === 'web' && app.specCount >= 2),
    'the clean fixture must actually contain web specs, or the control proves nothing'
  );
});

test('MONEY TEST: a planted orphan tag and orphan spec are caught and drive a non-zero exit', async () => {
  // Two hand-planted violations, each reproducing one real bug from `main`:
  //   - orphan tag: `@web-orphan-tag` is grepped by no lane, and its `@stateful`
  //     describe is grep-inverted out of the broad pass (the @web-indexing bug).
  //   - orphan spec: `@stateful` with no lane tag and in no lane file list (the
  //     production-csp.test.ts bug).
  const root = createFixtureRepo({
    webExtras: {
      'apps/web/e2e/orphan-spec.test.ts':
        "test.describe('Orphan spec', () => {\n  test('flow @stateful', async () => {});\n});\n",
      'apps/web/e2e/orphan-tag.test.ts':
        "test.describe('Orphan tag @stateful @web-orphan-tag', () => {\n  test('flow', async () => {});\n});\n",
    },
  });

  const report = await analyzeFixture(root);
  assert.deepEqual(kinds(report), ['orphan-spec', 'orphan-spec', 'orphan-tag']);

  const details = report.violations.map((violation) => violation.detail).join('\n');
  assert.match(details, /@web-orphan-tag/);
  assert.match(details, /orphan-spec\.test\.ts/);
  assert.match(details, /orphan-tag\.test\.ts/);

  // Computing violations is not the same as REPORTING them. A checker that
  // returns findings but never propagates them still exits 0 — the BST-836
  // shape exactly — so drive main() and demand the non-zero exit code.
  const previousExitCode = process.exitCode;
  const errors = [];
  const logs = [];
  try {
    process.exitCode = 0;
    await main({
      knownUnreachableSpecs: {},
      logger: { error: (line) => errors.push(line), log: (line) => logs.push(line) },
      minimums: FIXTURE_MINIMUMS,
      repoRoot: root,
    });
    assert.notEqual(
      process.exitCode,
      0,
      'main() reported success on a repo with two planted orphans. A guard that cannot go red ' +
        'is not evidence.'
    );
  } finally {
    process.exitCode = previousExitCode;
  }
  assert.deepEqual(logs, [], 'a failing run must not also print a success line');
  assert.match(errors.join('\n'), /E2E lane coverage check FAILED/);
  assert.match(errors.join('\n'), /@web-orphan-tag/);
  assert.match(errors.join('\n'), /orphan-spec\.test\.ts/);
});

test('MONEY TEST: direct execution reaches the check and can exit non-zero', () => {
  // The in-process test above imports main() directly, so it cannot see whether
  // the `import.meta.url === argv[1]` predicate actually fires. A guard that
  // parses everything and then never runs is the BST-836 library bug; spawn it.
  const emptyRoot = mkdtempSync(path.join(os.tmpdir(), 'bst1010-empty-root-'));
  temporaryRoots.push(emptyRoot);

  const onEmptyRoot = spawnSync(process.execPath, [GUARD], { cwd: emptyRoot, encoding: 'utf8' });
  assert.notEqual(
    onEmptyRoot.status,
    0,
    `The CLI exited ${onEmptyRoot.status} against a directory with no apps at all — a tree ` +
      'where it cannot honestly pass.'
  );
  assert.notEqual(`${onEmptyRoot.stdout}${onEmptyRoot.stderr}`.trim(), '');

  // ...and the same entrypoint reaches a real green, so the non-zero above is a
  // verdict rather than the script being broken outright.
  const onRealRepo = spawnSync(process.execPath, [GUARD], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(
    onRealRepo.status,
    0,
    `--- stdout ---\n${onRealRepo.stdout}\n--- stderr ---\n${onRealRepo.stderr}`
  );
  assert.match(onRealRepo.stdout, /E2E lane coverage check passed\./);
});

test('an exemption that is no longer true fails instead of rotting', async () => {
  // KNOWN_UNREACHABLE_SPECS is self-cleaning in both directions: a reachable
  // spec and a deleted spec must each fail rather than sit there forever.
  const reachable = await analyzeFixture(createFixtureRepo(), {
    'apps/web/e2e/broad.test.ts': 'this spec is reachable via the broad pass',
  });
  assert.deepEqual(kinds(reachable), ['stale-exemption']);
  assert.match(reachable.violations[0].detail, /now reachable/);

  const deleted = await analyzeFixture(createFixtureRepo(), {
    'apps/web/e2e/never-existed.test.ts': 'this spec is not in the tree at all',
  });
  assert.deepEqual(kinds(deleted), ['stale-exemption']);
  assert.match(deleted.violations[0].detail, /not a spec in the swept universe/);
});

test('MONEY TEST: a lane file list naming a file that no longer exists is caught', async () => {
  const report = await analyzeFixture(
    createFixtureRepo({
      webLanes: {
        'test:e2e:lane:renamed': `pnpm exec playwright test e2e/deleted-by-a-rename.test.ts ${LANE_FLAGS} --grep "@web-covered"`,
      },
    })
  );
  assert.ok(
    kinds(report).includes('missing-lane-file'),
    `expected a missing-lane-file violation, got ${JSON.stringify(kinds(report))}`
  );
});

test('MONEY TEST: a lane whose grep matches nothing is caught', async () => {
  const report = await analyzeFixture(
    createFixtureRepo({
      webLanes: {
        'test:e2e:lane:stale-grep': `pnpm exec playwright test ${LANE_FLAGS} --grep "@web-tag-nobody-carries"`,
      },
    })
  );
  assert.ok(
    kinds(report).includes('empty-lane'),
    `expected an empty-lane violation, got ${JSON.stringify(kinds(report))}`
  );
});

test('a lane script no CI entrypoint reaches cannot supply coverage', async () => {
  // The rescuing lane exists and greps the right tag, but nothing invokes it —
  // not the workflow, and not the full-regression chain. The spec must still be
  // reported, because in CI it runs nowhere.
  const report = await analyzeFixture(
    createFixtureRepo({
      webExtras: {
        'apps/web/e2e/rescued-by-nobody.test.ts':
          "test.describe('Detached @stateful @web-detached', () => {\n  test('flow', async () => {});\n});\n",
      },
      webLanes: {
        'test:e2e:lane:detached': `pnpm exec playwright test e2e/rescued-by-nobody.test.ts ${LANE_FLAGS} --grep "@web-detached"`,
      },
    })
  );
  assert.ok(
    kinds(report).includes('orphan-spec'),
    `expected the detached lane's spec to be reported, got ${JSON.stringify(kinds(report))}`
  );

  // Control: chaining the same lane into full-regression clears it, proving the
  // finding tracks CI invocation rather than merely the lane's existence.
  const chained = await analyzeFixture(
    createFixtureRepo({
      webExtras: {
        'apps/web/e2e/rescued-by-nobody.test.ts':
          "test.describe('Detached @stateful @web-detached', () => {\n  test('flow', async () => {});\n});\n",
      },
      webLanes: {
        'test:e2e:lane:detached': `pnpm exec playwright test e2e/rescued-by-nobody.test.ts ${LANE_FLAGS} --grep "@web-detached"`,
        'test:e2e:lane:full-regression': `pnpm exec playwright test ${LANE_FLAGS} --workers=2 --grep-invert "@destructive|@stateful" && pnpm run test:e2e:lane:covered && pnpm run test:e2e:lane:detached`,
      },
    })
  );
  assert.deepEqual(chained.violations, []);
});

test('anti-vacuity: discovery floors refuse to report a green on an empty sweep', async () => {
  const root = createFixtureRepo();
  await assert.rejects(
    () => analyzeE2eLaneCoverage({ repoRoot: root }),
    /Anti-vacuity floor/,
    'the real floors must reject the miniature fixture instead of passing it'
  );
});

test('anti-vacuity: an unmodelled --project throws instead of assuming no filter', async () => {
  const root = createFixtureRepo({
    webLanes: {
      'test:e2e:lane:invented': `pnpm exec playwright test --project=invented --grep "@web-covered" ${LANE_FLAGS.replace('--project=functional', '')}`,
    },
  });
  await assert.rejects(() => analyzeFixture(root), /PLAYWRIGHT_PROJECT_FILTERS/);
});

test('REAL REPO: every E2E spec is reachable from a CI-invoked lane', async () => {
  const report = await analyzeE2eLaneCoverage({ repoRoot: REPO_ROOT });
  assert.deepEqual(
    report.violations,
    [],
    `E2E lane coverage violations:\n${report.violations
      .map((violation) => `  [${violation.kind}] ${violation.app}: ${violation.detail}`)
      .join('\n')}`
  );
});

test('REAL REPO: the two BST-1010 orphans are wired into full-regression', async () => {
  const webScripts = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'apps/web/package.json'), 'utf8')
  ).scripts;
  const chain = webScripts['test:e2e:lane:full-regression'];

  for (const lane of ['test:e2e:lane:indexing', 'test:e2e:lane:production-csp']) {
    assert.ok(webScripts[lane], `${lane} must exist`);
    assert.ok(chain.includes(`pnpm run ${lane}`), `${lane} must be chained into full-regression`);
    // Serialized dedicated lanes are the correct fix for these two: background
    // indexing writes to the DB and the CSP spec runs PGlite search plus a real
    // local embedding, so neither may join the parallel broad pass by having its
    // @stateful tag deleted.
    assert.ok(webScripts[lane].includes('--workers=1'), `${lane} must stay serialized`);
  }

  // Placement, not just presence. `full-regression` is an `&&` chain, so a lane
  // at the tail is skipped whenever anything upstream fails — the worst spot for
  // specs whose entire defect was never running (BST-1032 blind windows).
  const laneOrder = [...chain.matchAll(/pnpm run (test:e2e:lane:[\w-]+)/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(
    laneOrder.slice(0, 2),
    ['test:e2e:lane:indexing', 'test:e2e:lane:production-csp'],
    'the two newly rescued lanes must run first in the chain, not last'
  );
});

test('REAL REPO: the spec-directory exclusions still match the Playwright configs', () => {
  // e2e-lane-coverage.mjs skips `__tests__` and web's `performance` dir. Both are
  // config facts, and a config change that invalidates one would silently shrink
  // the sweep, so re-derive them here.
  const webConfig = readFileSync(path.join(REPO_ROOT, 'apps/web/playwright.config.ts'), 'utf8');
  const desktopConfig = readFileSync(
    path.join(REPO_ROOT, 'apps/desktop/playwright.config.ts'),
    'utf8'
  );

  assert.match(webConfig, /testIgnore:\s*\[[^\]]*'\*\*\/__tests__\/\*\*'/);
  assert.match(desktopConfig, /testIgnore:\s*\[[^\]]*'\*\*\/__tests__\/\*\*'/);
  assert.match(
    webConfig,
    /testMatch: '\*\*\/!\(performance\)\/\*\.test\.ts'/,
    "web's functional/smoke projects must still exclude the performance dir; if that changed, " +
      'those specs belong in the swept universe.'
  );
  assert.match(
    webConfig,
    /name: 'performance'/,
    'the performance project (driven by performance.yml, not a lane) must still exist'
  );
});

test('REAL REPO: the modelled project grep filters still match the Playwright configs', () => {
  const desktopConfig = readFileSync(
    path.join(REPO_ROOT, 'apps/desktop/playwright.config.ts'),
    'utf8'
  );
  const webConfig = readFileSync(path.join(REPO_ROOT, 'apps/web/playwright.config.ts'), 'utf8');

  // desktop:regression's grepInvert is the only project filter that changes a
  // verdict — it means a @smoke-titled desktop spec missing from the smoke lane's
  // file list runs nowhere.
  assert.match(desktopConfig, /grepInvert: \/@smoke\/,\s*\n\s*name: 'regression',/);
  assert.match(desktopConfig, /grep: \/@smoke\/,\s*\n\s*name: 'smoke',/);
  assert.match(webConfig, /grep: \/@smoke\/,\s*\n\s*name: 'smoke',/);
  assert.doesNotMatch(
    webConfig,
    /grep(Invert)?: \/[^/]+\/,\s*\n\s*name: 'functional',/,
    "web's functional project is modelled as unfiltered"
  );
});
