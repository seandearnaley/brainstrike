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

/** notify-linear's `parts` input: each job's declared parts, else the one part `main`. */
function declaredParts(workflow) {
  const parts = new Map();
  for (const entry of String(workflow.jobs['notify-linear']?.with?.parts ?? '').split(',')) {
    const [job, names] = entry.split('=');
    if (names) {
      parts.set(job.trim(), names.trim().split(/\s+/u));
    }
  }
  return parts;
}

/** The <job>/<part> directory a report path or part directory names. */
function partOf(value) {
  const text = String(value);
  assert.ok(text.startsWith(RESULTS_ROOT), `${text} is outside ${RESULTS_ROOT}`);
  const [job, part] = text.slice(RESULTS_ROOT.length).split('/');
  return { dir: `${RESULTS_ROOT}${job}/${part}`, job, part };
}

/** A part named from the shard matrix expands to one part per shard. */
function expandParts(part, job) {
  const shard = expression('matrix.shard');
  return part.includes(shard)
    ? (job.strategy?.matrix?.shard ?? []).map((value) => part.replace(shard, String(value)))
    : [part];
}

function assertWorkflowWiring(file, source) {
  const workflow = parseYaml(source);
  const jobs = reportedJobs(workflow);
  const declared = declaredParts(workflow);
  let wiredSteps = 0;
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const steps = job.steps ?? [];
    const playwrightSteps = steps.filter(runsPlaywright);
    if (playwrightSteps.length === 0) {
      continue;
    }
    const where = (step) => `${file} › ${id} › ${step.name}`;
    const owners = new Set();
    for (const step of playwrightSteps) {
      const reportPaths = REPORT_ENV.map((name) => step.env?.[name]).filter(Boolean);
      assert.equal(
        reportPaths.length,
        1,
        `${where(step)} must write its JSON report with one of ${REPORT_ENV.join(', ')}`
      );
      const owner = partOf(reportPaths[0]);
      assert.ok(
        jobs.has(owner.job),
        `${where(step)} files under ${owner.job}, which notify-linear does not report`
      );
      owners.add(owner.dir);
      wiredSteps += 1;
    }
    assert.equal(
      owners.size,
      1,
      `${file} › ${id} is one part: every run reports into one directory`
    );
    const [partDir] = owners;
    const owner = partOf(partDir);
    assert.deepEqual(
      expandParts(owner.part, job),
      declared.get(owner.job) ?? ['main'],
      `${file} › ${id} reports as the parts notify-linear expects of ${owner.job}`
    );

    const status = steps.find((step) => step.env?.JOB_STATUS !== undefined);
    assert.ok(status, `${file} › ${id} must record its job status`);
    assert.equal(status.env.JOB_STATUS, expression('job.status'));
    assert.equal(status.env.PART_DIR, partDir, `${file} › ${id} records its status in its part`);
    assert.match(String(status.run), /> "\$PART_DIR\/job\.status"/u);
    assert.equal(
      status.if,
      expression('always()'),
      `${file} › ${id} records a red or cancelled status too`
    );

    const upload = steps.find((step) =>
      String(step.with?.name ?? '').startsWith('nightly-results--')
    );
    assert.ok(upload, `${file} › ${id} must upload a nightly-results--<job> artifact`);
    assert.match(String(upload.uses), /^actions\/upload-artifact@/u);
    assert.equal(
      upload.if,
      expression('always()'),
      `${file} › ${id} uploads its results on every night`
    );
    assert.equal(
      upload.with.path,
      RESULTS_ROOT,
      `${file} › ${id} uploads the whole results directory`
    );
    const [, artifactJob] = String(upload.with.name).split('--');
    assert.equal(
      artifactJob,
      owner.job,
      `${file} › ${id} artifact ${upload.with.name} names its job`
    );
    const order = (step) => steps.indexOf(step);
    assert.ok(
      playwrightSteps.every((step) => order(step) < order(status)) && order(status) < order(upload),
      `${file} › ${id}: tests, then the job status, then the upload`
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
  assert.match(file.run, /--parts "\$PARTS"/u);
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
    /\n {8}env:\n {10}PLAYWRIGHT_JSON_OUTPUT_FILE: \$\{\{ runner\.temp \}\}\/nightly-results\/desktop-embedding-e2e\/main\/embedding\.json/u,
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
    `if: ${expression('always()')}\n        uses: actions/upload-artifact@v7\n        with:\n          name: nightly-results--web-full-regression`,
    'if: failure()\n        uses: actions/upload-artifact@v7\n        with:\n          name: nightly-results--web-full-regression'
  );
  assert.throws(() => assertWorkflowWiring(file, mutated), /every night/u);
});

test('CONTROL: shards reporting under one part, or parts that miss a shard, FAIL this contract', () => {
  const file = '.github/workflows/desktop-e2e.yml';
  const source = read(file);
  const collapsed = source.replaceAll(
    `desktop-full-regression-gate/shard-${expression('matrix.shard')}`,
    'desktop-full-regression-gate/main'
  );
  assert.notEqual(collapsed, source);
  assert.throws(() => assertWorkflowWiring(file, collapsed), /parts notify-linear expects/u);
  const short = mutate(source, 'shard-1 shard-2 shard-3 shard-4', 'shard-1 shard-2 shard-3');
  assert.throws(() => assertWorkflowWiring(file, short), /parts notify-linear expects/u);
});

test('CONTROL: a job that records no status FAILS this contract', () => {
  const file = '.github/workflows/web-e2e.yml';
  const mutated = mutate(read(file), /\n {8}env:\n {10}JOB_STATUS: [^\n]+/u, '\n        env:');
  assert.throws(() => assertWorkflowWiring(file, mutated), /record its job status/u);
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
