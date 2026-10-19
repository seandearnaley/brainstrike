import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * BST-2189: Notify Linear files one issue per failing test, read from the
 * Playwright JSON reports each nightly test job uploads. The wiring is only
 * sound when every Playwright run writes a report into a directory named for a
 * job Notify Linear reports, and that directory is uploaded whatever the run's
 * verdict: a report filed under an unknown job, or one never uploaded, turns a
 * test failure into an unexplained red.
 *
 * Each check is a function over source text, so the CONTROL tests can mutate
 * the real files and watch the check fail.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const WIRED = ['.github/workflows/desktop-e2e.yml', '.github/workflows/web-e2e.yml'];
const ALERT = '.github/workflows/nightly-linear-alert.yml';
const expression = (body) => `${'$'}{{ ${body} }}`;
const RESULTS_ROOT = `${expression('runner.temp')}/nightly-results/`;
const REPORT_ENV = ['PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_JSON_OUTPUT_DIR'];

const runsPlaywright = (step) =>
  /\bplaywright test\b|\btest:e2e:lane:/u.test(String(step.run ?? ''));

function reportedJobs(workflow) {
  const results = String(workflow.jobs['notify-linear']?.with?.results ?? '');
  return new Set(results.split(',').map((entry) => entry.split('=')[0]));
}

/** The results job a report path names: nightly-results/<job>/... */
function reportJob(value) {
  assert.ok(String(value).startsWith(RESULTS_ROOT), `${value} is outside ${RESULTS_ROOT}`);
  return String(value).slice(RESULTS_ROOT.length).split('/')[0];
}

function assertWorkflowWiring(file, source) {
  const workflow = parseYaml(source);
  const jobs = reportedJobs(workflow);
  let wiredSteps = 0;
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const steps = job.steps ?? [];
    const playwrightSteps = steps.filter(runsPlaywright);
    if (playwrightSteps.length === 0) {
      continue;
    }
    for (const step of playwrightSteps) {
      const reportPaths = REPORT_ENV.map((name) => step.env?.[name]).filter(Boolean);
      assert.equal(
        reportPaths.length,
        1,
        `${file} › ${id} › ${step.name} must write its JSON report with one of ${REPORT_ENV.join(', ')}`
      );
      const owner = reportJob(reportPaths[0]);
      assert.ok(
        jobs.has(owner),
        `${file} › ${id} › ${step.name} files under ${owner}, which notify-linear does not report`
      );
      wiredSteps += 1;
    }
    const upload = steps.find((step) =>
      String(step.with?.name ?? '').startsWith('nightly-results--')
    );
    assert.ok(upload, `${file} › ${id} must upload a nightly-results--<job> artifact`);
    assert.match(String(upload.uses), /^actions\/upload-artifact@/u);
    assert.equal(
      upload.if,
      expression('!cancelled()'),
      `${file} › ${id} uploads its results on green nights too`
    );
    assert.equal(
      upload.with.path,
      RESULTS_ROOT,
      `${file} › ${id} uploads the whole results directory`
    );
    const [, owner] = String(upload.with.name).split('--');
    assert.ok(
      jobs.has(owner),
      `${file} › ${id} artifact ${upload.with.name} names no reported job`
    );
  }
  assert.ok(wiredSteps > 0, `${file} has no Playwright step to wire`);
}

function assertAlertDownloadsReports(source) {
  const steps = parseYaml(source).jobs.notify.steps;
  const download = steps.find((step) => String(step.uses).startsWith('actions/download-artifact@'));
  assert.ok(download, 'Notify Linear must download the nightly results');
  assert.equal(download.with.pattern, 'nightly-results--*');
  assert.equal(download.with.path, `${expression('runner.temp')}/nightly-results`);
  assert.equal(
    download.with['merge-multiple'],
    undefined,
    'one directory per artifact keeps shards apart'
  );
  const file = steps.find((step) => /notify-linear-nightly\.mjs/u.test(String(step.run)));
  assert.match(file.run, /--reports "\$RUNNER_TEMP\/nightly-results"/u);
  assert.ok(steps.indexOf(download) < steps.indexOf(file), 'download before filing');
}

function assertJsonReporter(source, file) {
  assert.match(
    source,
    /\['json', \{ outputFile: 'test-results\/results\.json' \}\]/u,
    `${file} must run the JSON reporter in CI`
  );
}

test('every nightly Playwright run reports under a job Notify Linear files', () => {
  for (const file of WIRED) {
    assertWorkflowWiring(file, read(file));
  }
});

test('Notify Linear reads the uploaded reports', () => {
  assertAlertDownloadsReports(read(ALERT));
});

test('the desktop and web Playwright configs write a JSON report in CI', () => {
  for (const file of ['apps/desktop/playwright.config.mts', 'apps/web/playwright.config.mts']) {
    assertJsonReporter(read(file), file);
  }
});

function mutate(source, from, to) {
  const mutated = source.replace(from, to);
  assert.notEqual(mutated, source, `control mutation ${String(from)} matched nothing`);
  return mutated;
}

test('CONTROL: a Playwright step without a report path FAILS this contract', () => {
  const file = '.github/workflows/desktop-e2e.yml';
  const mutated = mutate(
    read(file),
    /\n {8}env:\n {10}PLAYWRIGHT_JSON_OUTPUT_FILE: \$\{\{ runner\.temp \}\}\/nightly-results\/desktop-embedding-e2e\/embedding\.json/u,
    ''
  );
  assert.throws(() => assertWorkflowWiring(file, mutated), /must write its JSON report/u);
});

test('CONTROL: a report filed under an unreported job FAILS this contract', () => {
  const file = '.github/workflows/web-e2e.yml';
  const mutated = mutate(
    read(file),
    'nightly-results/web-full-regression',
    'nightly-results/web-regression'
  );
  assert.throws(() => assertWorkflowWiring(file, mutated), /does not report/u);
});

test('CONTROL: a failure-only results upload FAILS this contract', () => {
  const file = '.github/workflows/web-e2e.yml';
  const mutated = mutate(
    read(file),
    `if: ${expression('!cancelled()')}\n        uses: actions/upload-artifact@v7\n        with:\n          name: nightly-results--web-full-regression`,
    'if: failure()\n        uses: actions/upload-artifact@v7\n        with:\n          name: nightly-results--web-full-regression'
  );
  assert.throws(() => assertWorkflowWiring(file, mutated), /green nights too/u);
});

test('CONTROL: a notifier that never reads the reports FAILS this contract', () => {
  const mutated = mutate(read(ALERT), /--reports "\$RUNNER_TEMP\/nightly-results"\n/u, '');
  assert.throws(() => assertAlertDownloadsReports(mutated));
});

test('CONTROL: a config without the JSON reporter FAILS this contract', () => {
  const file = 'apps/desktop/playwright.config.mts';
  const mutated = mutate(read(file), "['json', { outputFile: 'test-results/results.json' }],", '');
  assert.throws(() => assertJsonReporter(mutated, file), /JSON reporter in CI/u);
});
