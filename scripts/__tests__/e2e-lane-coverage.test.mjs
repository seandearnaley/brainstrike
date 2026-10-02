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
import { parse as parseYaml } from 'yaml';

import { analyzeE2eLaneCoverage, main } from '../e2e-lane-coverage.mjs';
import { listPlaywrightTitleEntries } from '../e2e-playwright-title-tags.mjs';

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
function createFixtureRepo({
  includeDesktopTargetedScript = true,
  extraWorkflowSteps = [],
  webExtras = {},
  webLanes = {},
  webScripts = {},
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bst1010-lane-fixture-'));
  temporaryRoots.push(root);

  const scripts = {
    'test:e2e:lane:covered': `pnpm exec playwright test e2e/covered.test.ts ${LANE_FLAGS} --grep "@web-covered"`,
    'test:e2e:lane:full-regression': `pnpm exec playwright test ${LANE_FLAGS} --workers=2 --grep-invert "@destructive|@stateful" && pnpm run test:e2e:lane:covered`,
    ...webLanes,
    ...webScripts,
  };

  write(
    root,
    'apps/web/package.json',
    JSON.stringify({ name: '@brainstrike/web', scripts }, null, 2)
  );
  write(
    root,
    'apps/desktop/package.json',
    JSON.stringify(
      {
        name: '@brainstrike/desktop',
        scripts: {
          ...(includeDesktopTargetedScript
            ? {
                'test:e2e:backgrounding':
                  'pnpm exec playwright test e2e/desktop.test.ts --project=regression',
              }
            : {}),
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
      ...extraWorkflowSteps,
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
  desktop: {
    e2eScripts: 1,
    lanes: 1,
    laneTags: 0,
    specs: 1,
    targetedE2eScripts: 1,
    titles: 1,
  },
  web: {
    e2eScripts: 2,
    lanes: 1,
    laneTags: 1,
    specs: 2,
    targetedE2eScripts: 0,
    titles: 2,
  },
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

test('a whole-file exemption fails once the file is only PARTLY dark', async () => {
  // The per-title upgrade gives exemptions a new way to rot: a spec exempted as
  // a whole-file orphan that later has some titles picked up would silently keep
  // hiding the titles that are still dark. Only a fully dark file may be
  // exempted.
  const partiallyDark = await analyzeFixture(
    createFixtureRepo({
      webExtras: {
        'apps/web/e2e/half-dark.test.ts':
          "test.describe('Half dark', () => {\n" +
          "  test('sibling the broad pass runs', async () => {});\n" +
          "  test('sibling that runs nowhere @stateful', async () => {});\n" +
          '});\n',
      },
    }),
    { 'apps/web/e2e/half-dark.test.ts': 'claims the whole file is dark' }
  );
  assert.ok(
    kinds(partiallyDark).includes('stale-exemption'),
    `expected the partial exemption to be rejected, got ${JSON.stringify(kinds(partiallyDark))}`
  );
  assert.match(
    partiallyDark.violations.find((violation) => violation.kind === 'stale-exemption').detail,
    /1 of its 2 title\(s\) are now reachable/
  );
});

test('anti-vacuity: the title floor rejects a sweep that found no test titles', async () => {
  // The spec-file floor cannot catch this: a parser regression returning zero
  // titles per file leaves the file count healthy while every reachability
  // question becomes vacuous.
  await assert.rejects(
    () =>
      analyzeE2eLaneCoverage({
        knownUnreachableSpecs: {},
        minimums: {
          ...FIXTURE_MINIMUMS,
          web: { ...FIXTURE_MINIMUMS.web, titles: 5000 },
        },
        repoRoot: createFixtureRepo(),
      }),
    /Anti-vacuity floor: found \d+ web E2E test title\(s\)/
  );
});

test('MONEY TEST: a dark test beside a covered sibling in the SAME file is caught', async () => {
  // The review finding this test exists for: reachability answered per FILE
  // marks the whole spec covered as soon as ONE title is selected. Here the
  // first test is picked up by the broad pass and the second — untagged
  // `@stateful`, so grep-inverted out of the broad pass and greppable by no lane
  // — runs in no CI job. A file-granular guard reports this file as clean, which
  // is the guard's own bug class (BST-891/816/817) one level down.
  //
  // The other fixtures in this file would ALL have passed before the per-title
  // fix, so without this case the fix is unverified.
  const root = createFixtureRepo({
    webExtras: {
      'apps/web/e2e/half-dark.test.ts':
        "test.describe('Half dark', () => {\n" +
        "  test('sibling the broad pass runs', async () => {});\n" +
        "  test('sibling that runs nowhere @stateful', async () => {});\n" +
        '});\n',
    },
  });

  const report = await analyzeFixture(root);
  assert.deepEqual(
    kinds(report),
    ['orphan-title'],
    'a partially dark file must report the dark TITLE, not the whole file and not nothing'
  );

  // Naming the file is not enough — the author has to be told WHICH test is dark.
  const [violation] = report.violations;
  assert.match(violation.detail, /half-dark\.test\.ts:3/);
  assert.match(violation.detail, /Half dark sibling that runs nowhere @stateful/);
  assert.doesNotMatch(
    violation.detail,
    /sibling the broad pass runs/,
    'the covered sibling must not be reported as dark'
  );

  const previousExitCode = process.exitCode;
  const errors = [];
  try {
    process.exitCode = 0;
    await main({
      knownUnreachableSpecs: {},
      logger: { error: (line) => errors.push(line), log: () => {} },
      minimums: FIXTURE_MINIMUMS,
      repoRoot: root,
    });
    assert.notEqual(
      process.exitCode,
      0,
      'main() reported success on a file with a dark test beside a covered sibling.'
    );
  } finally {
    process.exitCode = previousExitCode;
  }
  assert.match(errors.join('\n'), /runs in no CI job/);
});

test('control: the same file is clean once a lane picks the dark test up', async () => {
  // Proves the finding above tracks real selection rather than merely the
  // presence of `@stateful`: same file, plus a lane that greps it.
  const report = await analyzeFixture(
    createFixtureRepo({
      webExtras: {
        'apps/web/e2e/half-dark.test.ts':
          "test.describe('Half dark', () => {\n" +
          "  test('sibling the broad pass runs', async () => {});\n" +
          "  test('sibling rescued by a lane @stateful @web-rescued', async () => {});\n" +
          '});\n',
      },
      webLanes: {
        'test:e2e:lane:full-regression': `pnpm exec playwright test ${LANE_FLAGS} --workers=2 --grep-invert "@destructive|@stateful" && pnpm run test:e2e:lane:covered && pnpm run test:e2e:lane:rescued`,
        'test:e2e:lane:rescued': `pnpm exec playwright test e2e/half-dark.test.ts ${LANE_FLAGS} --grep "@web-rescued"`,
      },
    })
  );
  assert.deepEqual(report.violations, []);
});

test('MONEY TEST: options-form tags are modelled, not read as untagged', async () => {
  // Playwright greps against `[...titlePath, ...tags]` (`_grepTitleWithTags`),
  // and tags include the `{ tag: '@x' }` options form — which is NOT part of any
  // title string. Reading title literals only made the guard wrong in both
  // directions; it missed three real desktop orphans whose whole `@smoke` tag
  // lives in an options object.
  //
  // Here the tag is grep-inverted out of the broad pass and greppable by no
  // lane, so the spec runs nowhere — invisible to a title-literals-only parser.
  const optionTagOrphan = await analyzeFixture(
    createFixtureRepo({
      webExtras: {
        'apps/web/e2e/option-tagged.test.ts':
          "test.describe('Option tagged', { tag: '@stateful' }, () => {\n" +
          "  test('runs nowhere', async () => {});\n" +
          '});\n',
      },
    })
  );
  assert.ok(
    kinds(optionTagOrphan).includes('orphan-spec'),
    `an options-form tag must affect selection, got ${JSON.stringify(kinds(optionTagOrphan))}`
  );

  // Control, and the half that proves the tag is genuinely being applied rather
  // than the file being broken: the same spec with the tag moved into a lane's
  // grep is clean. Array form too, since Playwright accepts `tag: [...]`.
  const rescued = await analyzeFixture(
    createFixtureRepo({
      webExtras: {
        'apps/web/e2e/option-tagged.test.ts':
          "test.describe('Option tagged', { tag: ['@stateful', '@web-covered'] }, () => {\n" +
          "  test('runs in the covered lane', async () => {});\n" +
          '});\n',
      },
      webLanes: {
        'test:e2e:lane:covered': `pnpm exec playwright test e2e/covered.test.ts e2e/option-tagged.test.ts ${LANE_FLAGS} --grep "@web-covered"`,
      },
    })
  );
  assert.deepEqual(rescued.violations, []);
});

test('a tag that cannot be read statically is refused, not assumed absent', async () => {
  // `{ tag: SOME_CONST }` makes every selection answer for that test a guess.
  // Treating it as untagged is the silent-fallback failure mode.
  await assert.rejects(
    () =>
      analyzeFixture(
        createFixtureRepo({
          webExtras: {
            'apps/web/e2e/dynamic-tag.test.ts':
              "const LANE = '@web-covered';\n" +
              "test('dynamic', { tag: LANE }, async () => {});\n",
          },
        })
      ),
    /cannot be read statically/
  );
});

test('an apostrophe in an unrelated workflow step does not break the sweep', async () => {
  // `splitCommandSegments` is quote-aware, so before the line-oriented split a
  // single `'` in any `run:` block of the three scanned workflows swallowed
  // newlines, merged unrelated segments, and failed the whole Static job with
  // "unterminated quote in playwright command" — naming Playwright for a step
  // that never mentions it. test.yml is large and frequently edited.
  const report = await analyzeFixture(
    createFixtureRepo({
      extraWorkflowSteps: [
        '  unrelated:',
        '    steps:',
        '      - name: Cache note',
        '        run: |',
        "          # don't reuse the cache here",
        '          echo "can\'t find it"',
        '      - name: Sibling of a real lane',
        '        working-directory: apps/desktop',
        '        run: |',
        "          # we don't want stale state",
        '          pnpm run test:e2e:lane:full-regression',
      ],
    })
  );
  assert.deepEqual(
    report.violations,
    [],
    'an apostrophe in an unrelated step (or above a real lane invocation) must not fail the sweep'
  );
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
    kinds(report).includes('missing-e2e-file'),
    `expected a missing-e2e-file violation, got ${JSON.stringify(kinds(report))}`
  );
});

test('MONEY TEST: the same dangling file is caught in a non-lane E2E script', async () => {
  const report = await analyzeFixture(
    createFixtureRepo({
      webScripts: {
        'test:e2e:diagnostic': `pnpm exec playwright test e2e/deleted-by-a-rename.test.ts ${LANE_FLAGS} --grep "@web-covered"`,
      },
    })
  );
  assert.ok(
    kinds(report).includes('missing-e2e-file'),
    `expected a missing-e2e-file violation, got ${JSON.stringify(kinds(report))}`
  );
});

test('control: a targeted non-lane E2E script with a live selector is accepted', async () => {
  const report = await analyzeFixture(
    createFixtureRepo({
      webScripts: {
        'test:e2e:diagnostic': `pnpm exec playwright test e2e/covered.test.ts ${LANE_FLAGS} --grep "@web-covered"`,
      },
    })
  );
  assert.deepEqual(report.violations, []);
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
    kinds(report).includes('empty-e2e-selection'),
    `expected an empty-e2e-selection violation, got ${JSON.stringify(kinds(report))}`
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

test('anti-vacuity: removing the targeted non-lane script turns its consumed-list floor red', async () => {
  await assert.rejects(
    () => analyzeFixture(createFixtureRepo({ includeDesktopTargetedScript: false })),
    /Anti-vacuity floor: found 0 desktop explicitly targeted non-lane test:e2e\* package invocation\(s\)/
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

test('REAL REPO: every E2E TEST is reachable from a CI-invoked lane', async () => {
  const report = await analyzeE2eLaneCoverage({ repoRoot: REPO_ROOT });
  assert.deepEqual(
    report.violations,
    [],
    `E2E lane coverage violations:\n${report.violations
      .map((violation) => `  [${violation.kind}] ${violation.app}: ${violation.detail}`)
      .join('\n')}`
  );
});

test('REAL REPO: packaged MCP core has one isolated packaged-artifact CI lane', () => {
  const desktopPackage = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'apps/desktop/package.json'), 'utf8')
  );
  const packagedSpecPath = path.join(
    REPO_ROOT,
    'apps/desktop/e2e/mcp-packaged-core.desktop.test.ts'
  );
  const entries = listPlaywrightTitleEntries(
    readFileSync(packagedSpecPath, 'utf8'),
    packagedSpecPath
  ).filter(({ kind }) => kind === 'test');
  assert.ok(entries.length > 0, 'packaged MCP core spec has no Playwright test');
  for (const entry of entries) {
    assert.match(entry.titlePath, /(?:^|\s)@packaged(?:\s|$)/u);
    assert.match(entry.titlePath, /(?:^|\s)@destructive(?:\s|$)/u);
  }

  const scripts = desktopPackage.scripts;
  assert.equal(
    desktopPackage.build?.linux?.executableName,
    'brainstrike-desktop',
    'Linux packaging must expose the executable name used by the packaged verifier'
  );
  const laneName = 'test:e2e:lane:packaged-mcp-core';
  const lane = scripts[laneName];
  assert.equal(typeof lane, 'string', `${laneName} must exist`);
  assert.match(lane, /e2e\/mcp-packaged-core\.desktop\.test\.ts/u);
  assert.doesNotMatch(lane, /(?:^|\s)(?:pnpm\s+(?:run\s+)?pack|electron-builder)(?:\s|$)/u);
  assert.match(scripts['test:e2e:lane:full-regression'], /--grep-invert=["'][^"']*@packaged/u);
  assert.match(scripts['test:e2e:mcp-packaged'], /pnpm run test:e2e:lane:packaged-mcp-core/u);

  const packagedLauncher = readFileSync(
    path.join(REPO_ROOT, 'apps/desktop/e2e/utils/packaged-electron.ts'),
    'utf8'
  );
  const stdioFixture = readFileSync(
    path.join(REPO_ROOT, 'packages/mcp-test-lab/fixtures/stdio-reference-server.mjs'),
    'utf8'
  );
  const oauthBrowserFixture = readFileSync(
    path.join(REPO_ROOT, 'packages/mcp-test-lab/fixtures/oauth-browser-client.mjs'),
    'utf8'
  );
  assert.doesNotMatch(packagedLauncher, /Object\.entries\(process\.env\)/u);
  assert.match(packagedLauncher, /PACKAGED_DESKTOP_INHERITED_ENV_KEYS/u);
  assert.match(packagedLauncher, /DBUS_SESSION_BUS_ADDRESS/u);
  assert.match(packagedLauncher, /GNOME_KEYRING_CONTROL/u);
  assert.match(packagedLauncher, /--password-store=gnome-libsecret/u);
  assert.match(packagedLauncher, /XDG_CONFIG_HOME/u);
  assert.match(packagedLauncher, /XDG_CURRENT_DESKTOP/u);
  assert.match(packagedLauncher, /XDG_DATA_HOME/u);
  assert.match(readFileSync(packagedSpecPath, 'utf8'), /oauth-browser-client\.mjs/u);
  assert.match(readFileSync(packagedSpecPath, 'utf8'), /BRAINSTRIKE_MCP_OAUTH_BROWSER_STATE_FILE/u);
  assert.match(readFileSync(packagedSpecPath, 'utf8'), /xdg-mime/u);
  assert.match(readFileSync(packagedSpecPath, 'utf8'), /x-scheme-handler\/http/u);
  assert.match(readFileSync(packagedSpecPath, 'utf8'), /X-Generic/u);
  assert.match(oauthBrowserFixture, /redirect: 'manual'/u);
  assert.match(oauthBrowserFixture, /hostname !== '127\.0\.0\.1'/u);
  assert.doesNotMatch(stdioFixture, /--brainstrike-production-env/u);
  assert.match(stdioFixture, /--brainstrike-expected-inherited-env=/u);

  const workflow = parseYaml(
    readFileSync(path.join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8')
  );
  const steps = workflow.jobs?.['native-electron']?.steps;
  assert.ok(Array.isArray(steps), 'test.yml has no native-electron steps');
  const dependencyBuild = steps.find(({ name }) => name === 'Build desktop dependency graph');
  assert.match(
    String(dependencyBuild?.run),
    /--filter=@brainstrike\/mcp-test-lab/u,
    'native-electron must build the packaged verifier fixtures before packaging'
  );
  const desktopServices = steps.find(({ name }) => name === 'Provision Linux desktop services');
  assert.match(String(desktopServices?.run), /dbus-x11/u);
  assert.match(String(desktopServices?.run), /gnome-keyring/u);
  assert.match(String(desktopServices?.run), /xdg-utils/u);
  const watcherIndex = steps.findIndex(
    ({ name }) => name === 'Load the packaged @parcel/watcher binding in Electron (BST-568)'
  );
  const laneIndex = steps.findIndex(({ run }) =>
    String(run).includes('pnpm --filter @brainstrike/desktop run test:e2e:lane:packaged-mcp-core')
  );
  assert.ok(watcherIndex > -1, 'native-electron has no packaged watcher check');
  assert.equal(
    laneIndex,
    watcherIndex + 1,
    'packaged MCP core must run immediately after the packaged native checks'
  );
  assert.match(
    String(steps[laneIndex]?.run),
    /test:e2e:lane:packaged-mcp-core/u,
    'native-electron must invoke the canonical package lane'
  );
  assert.match(String(steps[laneIndex]?.run), /dbus-run-session/u);
  assert.match(String(steps[laneIndex]?.run), /gnome-keyring-daemon --unlock/u);
  assert.match(String(steps[laneIndex]?.run), /XDG_CONFIG_HOME=.*mktemp -d/u);
  assert.match(String(steps[laneIndex]?.run), /XDG_CURRENT_DESKTOP=GNOME/u);
  assert.match(String(steps[laneIndex]?.run), /XDG_DATA_HOME=.*mktemp -d/u);
  const uploadStep = steps[laneIndex + 1];
  assert.equal(uploadStep?.name, 'Upload packaged MCP test diagnostics');
  assert.equal(uploadStep?.uses, 'actions/upload-artifact@v7');
  assert.equal(uploadStep?.with?.path, 'apps/desktop/blob-report');
  assert.match(String(uploadStep?.if), /failure\(\)/u);
});

test('REAL REPO: the two BST-1010 orphans are fail-late full-regression lanes', async () => {
  const webScripts = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'apps/web/package.json'), 'utf8')
  ).scripts;
  const chain = webScripts['test:e2e:lane:full-regression'];

  for (const lane of ['test:e2e:lane:indexing', 'test:e2e:lane:production-csp']) {
    assert.ok(webScripts[lane], `${lane} must exist`);
    assert.ok(chain.includes(lane), `${lane} must be delegated by full-regression`);
    // Serialized dedicated lanes are the correct fix for these two: background
    // indexing writes to the DB and the CSP spec runs PGlite search plus a real
    // local embedding, so neither may join the parallel broad pass by having its
    // @stateful tag deleted.
    assert.ok(webScripts[lane].includes('--workers=1'), `${lane} must stay serialized`);
  }

  // Preserve the established order, but do not restore the former `&&` chain:
  // the aggregate runner must attempt these tail lanes even when an earlier lane
  // fails (BST-1059 closes the BST-1032 short-circuit window).
  assert.doesNotMatch(chain, /&&/);
  const laneOrder = chain.split(' ').filter((token) => token.startsWith('test:e2e:lane:'));
  assert.deepEqual(
    laneOrder.slice(-2),
    ['test:e2e:lane:indexing', 'test:e2e:lane:production-csp'],
    'the two rescued lanes must remain last while the aggregate runner guarantees fail-late execution'
  );
});

test('REAL REPO: the spec-directory exclusions still match the Playwright configs', () => {
  // e2e-lane-coverage.mjs skips `__tests__` and web's `performance` dir. Both are
  // config facts, and a config change that invalidates one would silently shrink
  // the sweep, so re-derive them here.
  const webConfig = readFileSync(path.join(REPO_ROOT, 'apps/web/playwright.config.mts'), 'utf8');
  const desktopConfig = readFileSync(
    path.join(REPO_ROOT, 'apps/desktop/playwright.config.mts'),
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
    path.join(REPO_ROOT, 'apps/desktop/playwright.config.mts'),
    'utf8'
  );
  const webConfig = readFileSync(path.join(REPO_ROOT, 'apps/web/playwright.config.mts'), 'utf8');

  // desktop:regression excludes smoke- and perf-tagged tests, so their coverage
  // must come from explicit lanes.
  assert.match(desktopConfig, /grepInvert: \/@smoke\|@perf\/,\s*\n\s*name: 'regression',/);
  assert.match(desktopConfig, /grep: \/@smoke\/,\s*\n\s*name: 'smoke',/);
  assert.match(desktopConfig, /grep: \/@perf\/,\s*\n\s*name: 'perf',/);
  assert.match(webConfig, /grep: \/@smoke\/,\s*\n\s*name: 'smoke',/);
  assert.doesNotMatch(
    webConfig,
    /grep(Invert)?: \/[^/]+\/,\s*\n\s*name: 'functional',/,
    "web's functional project is modelled as unfiltered"
  );
});
