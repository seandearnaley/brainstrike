import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * BST-2188: nothing lands on main untested. GitHub's merge queue runs
 * merge-queue.yml on each merge group, and its one gate job is the check the
 * ruleset requires. Per-push PR CI stays off, so the workflow never runs on
 * pull_request or push.
 *
 * The gate fails unless every lane succeeded; only a Unit matrix that Plan
 * verified empty may skip. The lanes are copies of the nightly's (test.yml),
 * so each copy must stay identical to its nightly job, apart from the listed
 * deliberate differences.
 *
 * Each check is a function over source text, so the CONTROL tests can mutate
 * the real files and watch the check fail.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const MERGE_QUEUE = '.github/workflows/merge-queue.yml';
const NIGHTLY = '.github/workflows/test.yml';

const GATE = 'merge-queue-gate';
const GATE_NAME = 'Merge Queue Gate';
const JUDGE_STEP = 'Judge every lane';
const FORK_GUARD = "github.repository == 'seandearnaley/brainstrike'";
const actions = (body) => `${'$'}{{ ${body} }}`;
const MERGE_GROUP_BASE = actions('github.event.merge_group.base_sha');
const ADMISSION_GUARD = 'Require successful admission';
const COPIED_LANES = ['static', 'build', 'web-e2e', 'desktop-e2e-smoke', 'desktop-e2e-delegated'];
const LANE_FIELDS = ['name', 'runs-on', 'container', 'env', 'timeout-minutes', 'steps'];

const normalize = (text) => String(text).replace(/\s+/gu, ' ').trim();
const without = (object, ...keys) =>
  Object.fromEntries(Object.entries(object ?? {}).filter(([key]) => !keys.includes(key)));

function assertTriggers(source) {
  const { on } = parseYaml(source);
  assert.deepEqual(
    Object.keys(on).sort(),
    ['merge_group', 'workflow_dispatch'],
    'merge-queue.yml must run only on merge groups and manual dispatch'
  );
  assert.deepEqual(
    on.merge_group,
    { branches: ['main'], types: ['checks_requested'] },
    'merge-queue.yml must run on every merge group for main'
  );
}

function judgeStep(source) {
  const step = parseYaml(source).jobs[GATE]?.steps?.find(({ name }) => name === JUDGE_STEP);
  assert.ok(step, `merge-queue.yml › ${GATE} must have a "${JUDGE_STEP}" step`);
  return step;
}

/** The required check waits for every job and reads every job's result. */
function assertGate(source) {
  const { jobs } = parseYaml(source);
  const gate = jobs[GATE];
  assert.ok(gate, `merge-queue.yml must define ${GATE}`);
  assert.equal(gate.name, GATE_NAME, 'the ruleset requires the gate by this exact name');
  assert.equal(
    normalize(gate.if),
    `${FORK_GUARD} && always()`,
    'the gate must report a verdict even when a lane fails or is skipped'
  );
  const lanes = Object.keys(jobs)
    .filter((id) => id !== GATE)
    .sort();
  assert.deepEqual([gate.needs ?? []].flat().sort(), lanes, 'the gate must wait for every job');
  const judged = Object.entries(judgeStep(source).env ?? {})
    .filter(([name]) => name.startsWith('RESULT_'))
    .map(([, value]) => /^\$\{\{ needs\.([a-z0-9-]+)\.result \}\}$/u.exec(value)?.[1])
    .sort();
  assert.deepEqual(judged, lanes, 'the gate must judge the result of every job');
}

/** Runs the gate's verdict script with every job successful unless overridden. */
function runJudge(source, overrides = {}) {
  const step = judgeStep(source);
  const results = Object.fromEntries(
    Object.keys(step.env)
      .filter((name) => name.startsWith('RESULT_'))
      .map((name) => [name, 'success'])
  );
  return spawnSync('bash', ['-c', step.run], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...results, UNIT_SHARD_COUNT: '9', ...overrides },
  });
}

/** The nightly job as the merge queue copies it, with its deliberate differences. */
function nightlyLane(nightlyJobs, id) {
  const job = nightlyJobs[id];
  const unconditional = (name) => (step) => (step.name === name ? without(step, 'if') : step);
  let steps = job.steps.filter(({ name }) => name !== ADMISSION_GUARD);
  if (id === 'static') {
    // Plan owns Unit selection, so Unit starts without waiting for Static and a
    // red Static cannot skip Unit. With no pull_request event, the PR-only MCP
    // change detection never runs and the MCP verification always does.
    steps = steps
      .filter((step) => !['unit-shards', 'mcp-paths'].includes(step.id))
      .map(unconditional('MCP representative verification'));
  }
  if (id === 'build') {
    // The queue's E2E lanes also run on manual dispatch, so the artifacts always upload.
    steps = steps.map(unconditional('Upload build artifacts'));
  }
  return { ...job, steps };
}

function assertLaneParity(mergeQueueSource, nightlySource) {
  const jobs = parseYaml(mergeQueueSource).jobs;
  const nightlyJobs = parseYaml(nightlySource).jobs;
  for (const id of COPIED_LANES) {
    const expected = nightlyLane(nightlyJobs, id);
    for (const field of LANE_FIELDS) {
      assert.deepEqual(
        jobs[id]?.[field],
        expected[field],
        `merge-queue.yml › ${id}.${field} must match test.yml`
      );
    }
  }
}

const isUnitCommand = (step) => /\bturbo run test(:integration)? /u.test(step.run ?? '');

/** Unit runs the nightly matrix, commands and environment, against the merge group's base. */
function assertUnitParity(mergeQueueSource, nightlySource) {
  const jobs = parseYaml(mergeQueueSource).jobs;
  const nightlyJobs = parseYaml(nightlySource).jobs;
  const selection = (steps) => steps?.find(({ id }) => id === 'unit-shards');
  const planned = selection(jobs.plan?.steps);
  const nightlySelection = selection(nightlyJobs.static.steps);
  assert.ok(planned, 'merge-queue.yml › plan must select the Unit shards');
  assert.deepEqual(
    JSON.parse(planned.env.UNIT_MATRIX),
    JSON.parse(nightlySelection.env.UNIT_MATRIX),
    'the merge queue must shard Unit exactly as the nightly does'
  );
  assert.equal(planned.env.TURBO_SCM_BASE, MERGE_GROUP_BASE, 'Plan selects against the group base');
  assert.deepEqual(
    without(planned, 'env'),
    without(nightlySelection, 'env'),
    'Plan must run the nightly selection command'
  );
  assert.deepEqual(
    without(planned.env, 'TURBO_SCM_BASE', 'UNIT_MATRIX'),
    without(nightlySelection.env, 'TURBO_SCM_BASE', 'UNIT_MATRIX'),
    'Plan must select with the nightly environment'
  );

  const shard = jobs['unit-shard'];
  const nightlyShard = nightlyJobs['unit-shard'];
  for (const field of ['name', 'runs-on', 'timeout-minutes']) {
    assert.deepEqual(shard[field], nightlyShard[field], `merge-queue.yml › unit-shard.${field}`);
  }
  assert.deepEqual(shard.strategy, {
    'fail-fast': nightlyShard.strategy['fail-fast'],
    matrix: actions('fromJSON(needs.plan.outputs.unit-matrix)'),
  });
  const nightlySteps = nightlyShard.steps.filter(({ name }) => name !== ADMISSION_GUARD);
  assert.deepEqual(
    shard.steps.filter((step) => !isUnitCommand(step)),
    nightlySteps.filter((step) => !isUnitCommand(step)),
    'Unit must provision its runner exactly as the nightly does'
  );
  const commands = shard.steps.filter(isUnitCommand);
  const nightlyCommands = nightlySteps.filter(isUnitCommand);
  assert.equal(commands.length, nightlyCommands.length, 'Unit must run every nightly phase');
  for (const step of commands) {
    const affected = step.run.includes('--affected');
    assert.equal(
      step.if,
      affected ? "github.event_name == 'merge_group'" : "github.event_name != 'merge_group'",
      `${step.name}: a merge group runs only the affected phases, a dispatch only the full ones`
    );
    if (affected) {
      assert.equal(step.env.TURBO_SCM_BASE, MERGE_GROUP_BASE, `${step.name} base`);
    }
    const twin = nightlyCommands.find(({ run }) => run === step.run);
    assert.ok(twin, `${step.name} must run a nightly Unit command`);
    assert.deepEqual(
      without(step.env, 'TURBO_SCM_BASE'),
      without(twin.env, 'TURBO_SCM_BASE'),
      `${step.name} must run with the nightly environment`
    );
  }
}

test('the merge queue runs only on merge groups and manual dispatch', () => {
  assertTriggers(read(MERGE_QUEUE));
});

test('the gate waits for and judges every job', () => {
  assertGate(read(MERGE_QUEUE));
});

test('the gate passes only when every lane succeeded or Unit was verified empty', () => {
  const source = read(MERGE_QUEUE);
  assert.equal(runJudge(source).status, 0, runJudge(source).stdout);
  const lanes = Object.keys(judgeStep(source).env).filter((name) => name.startsWith('RESULT_'));
  for (const name of lanes) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.notEqual(runJudge(source, { [name]: result }).status, 0, `${name}=${result}`);
    }
  }
  const unitSkipped = { RESULT_UNIT_SHARD: 'skipped' };
  assert.equal(runJudge(source, { ...unitSkipped, UNIT_SHARD_COUNT: '0' }).status, 0);
  assert.notEqual(runJudge(source, { ...unitSkipped, UNIT_SHARD_COUNT: '' }).status, 0);
  assert.notEqual(
    runJudge(source, { ...unitSkipped, RESULT_PLAN: 'failure', UNIT_SHARD_COUNT: '0' }).status,
    0
  );
});

test('the copied lanes match their nightly jobs', () => {
  assertLaneParity(read(MERGE_QUEUE), read(NIGHTLY));
});

test('Unit runs the nightly matrix, commands and environment against the merge group base', () => {
  assertUnitParity(read(MERGE_QUEUE), read(NIGHTLY));
});

function mutate(source, from, to) {
  const mutated = source.replace(from, to);
  assert.notEqual(mutated, source, `control mutation ${String(from)} matched nothing`);
  return mutated;
}

test('CONTROL: a pull_request or push trigger fails the trigger check', () => {
  const source = read(MERGE_QUEUE);
  for (const trigger of [
    'pull_request:\n    branches: [main]\n',
    'push:\n    branches: [main]\n',
  ]) {
    const mutated = mutate(source, '\non:\n', `\non:\n  ${trigger}`);
    assert.throws(() => assertTriggers(mutated), /only on merge groups and manual dispatch/u);
  }
});

test('CONTROL: a lane the gate does not wait for or judge fails the gate check', () => {
  const source = read(MERGE_QUEUE);
  const unwaited = mutate(
    source,
    /needs: \[plan, static, unit-shard, build, web-e2e, /u,
    'needs: [plan, static, unit-shard, build, '
  );
  assert.throws(() => assertGate(unwaited), /wait for every job/u);
  const unjudged = mutate(source, /^ {10}RESULT_WEB_E2E: .*\n/mu, '');
  assert.throws(() => assertGate(unjudged), /judge the result of every job/u);
});

test('CONTROL: a drifted lane copy or Unit matrix fails the parity checks', () => {
  const source = read(MERGE_QUEUE);
  const nightly = read(NIGHTLY);
  const drifted = mutate(
    source,
    'run: dbus-run-session -- pnpm run test:e2e:lane:smoke-delegated',
    'run: dbus-run-session -- pnpm run test:e2e:lane:smoke'
  );
  assert.throws(() => assertLaneParity(drifted, nightly), /desktop-e2e-delegated\.steps/u);
  const nightlyOnly = mutate(nightly, 'run: pnpm run lint:ci', 'run: pnpm run lint:ci --strict');
  assert.throws(() => assertLaneParity(source, nightlyOnly), /static\.steps/u);
  const matrix = mutate(source, '"vitest_shard": "3/3"', '"vitest_shard": "3/4"');
  assert.throws(() => assertUnitParity(matrix, nightly), /shard Unit exactly/u);
  const unbased = mutate(
    source,
    /(Merge group affected unit tests[\s\S]*?TURBO_SCM_BASE: )\$\{\{ github\.event\.merge_group\.base_sha \}\}/u,
    `$1${actions('github.event.before')}`
  );
  assert.throws(() => assertUnitParity(unbased, nightly), /Merge group affected unit tests base/u);
});
