import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * BST-2188: nothing lands on main untested. GitHub's merge queue runs
 * merge-queue.yml on each merge group. That workflow calls test.yml with
 * `merge-queue: true`, so the fast tier is the nightly's own Static, Unit,
 * Build and smoke E2E jobs, not a copy of them. Its one gate job is the check
 * the ruleset requires.
 *
 * GitHub requires that check to pass on a PR before the PR may enter the queue,
 * so the workflow also triggers on pull_request, skip-only (owner decision
 * 2026-10-19): every job skips on that event, which GitHub reports to required
 * checks as success, and no runner starts. It never triggers on push.
 *
 * Each check is a function over source text, so the CONTROL tests can mutate
 * the real files and watch the check fail.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const readWorkflow = (file) => readFileSync(path.join(workflowsDir, file), 'utf8');
const MERGE_QUEUE = 'merge-queue.yml';
const NIGHTLY = 'test.yml';

const CALL = 'test';
const GATE = 'merge-queue-gate';
const GATE_NAME = 'Merge Queue Gate';
const JUDGE_STEP = 'Judge every job';
const FORK_GUARD = "github.repository == 'seandearnaley/brainstrike'";
const SKIPS_PULL_REQUEST = "github.event_name != 'pull_request'";
const SCHEDULE_ONLY = "github.event_name == 'schedule'";
const OUTSIDE_THE_QUEUE = '!inputs.merge-queue';
const actions = (body) => `${'$'}{{ ${body} }}`;
const AFFECTED_BASE = actions(
  'github.event.pull_request.base.sha || github.event.merge_group.base_sha'
);
const AFFECTED_HEAD = actions('github.event.merge_group.head_sha || github.sha');

const normalize = (text) =>
  String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
const expression = (value) =>
  normalize(value)
    .replace(/^\$\{\{\s*/u, '')
    .replace(/\s*\}\}$/u, '');
/**
 * The top-level `&&` operands of a condition, or null when it has a top-level
 * `||` or a negated group: then no single operand decides that it is false.
 */
function conjuncts(condition) {
  const text = expression(condition);
  if (text === '' || text.includes('!(')) {
    return null;
  }
  const operands = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '(') {
      depth += 1;
    } else if (text[index] === ')') {
      depth -= 1;
    } else if (depth === 0 && text.startsWith(' || ', index)) {
      return null;
    } else if (depth === 0 && text.startsWith(' && ', index)) {
      operands.push(text.slice(start, index));
      start = index + ' && '.length;
    }
  }
  operands.push(text.slice(start));
  return operands;
}
const envName = (jobId) => jobId.toUpperCase().replaceAll('-', '_');

function assertTriggers(source) {
  const { on, jobs } = parseYaml(source);
  const triggers = Object.keys(on).sort();
  assert.deepEqual(
    triggers.filter((name) => name !== 'pull_request'),
    ['merge_group', 'workflow_dispatch'],
    'merge-queue.yml must run on merge groups and manual dispatch, never on push or a schedule'
  );
  assert.deepEqual(
    on.merge_group,
    { branches: ['main'], types: ['checks_requested'] },
    'merge-queue.yml must run on every merge group for main'
  );
  if (!triggers.includes('pull_request')) {
    return;
  }
  for (const [id, job] of Object.entries(jobs)) {
    assert.ok(
      conjuncts(job.if)?.includes(SKIPS_PULL_REQUEST),
      `merge-queue.yml › ${id} must skip on pull_request: its if: needs a top-level "&& ${SKIPS_PULL_REQUEST}" and no "||"`
    );
  }
}

/** The fast tier is test.yml itself, with only the secret it needs. */
function assertCall(source) {
  const call = parseYaml(source).jobs[CALL];
  assert.ok(call, `merge-queue.yml must define the ${CALL} job`);
  assert.equal(call.uses, `./.github/workflows/${NIGHTLY}`, 'the queue runs test.yml, not a copy');
  assert.deepEqual(call.with, { 'merge-queue': true });
  assert.deepEqual(
    call.secrets,
    { TURBO_TOKEN: actions('secrets.TURBO_TOKEN') },
    'pass only the secrets the queue needs, explicitly; never inherit'
  );
}

/** Jobs of test.yml that cannot run when merge-queue.yml calls it. */
function nightlyOnlyJobs(nightlySource) {
  return Object.entries(parseYaml(nightlySource).jobs)
    .filter(([, job]) => {
      const operands = conjuncts(job.if) ?? [];
      return operands.includes(OUTSIDE_THE_QUEUE) || operands.includes(SCHEDULE_ONLY);
    })
    .map(([id]) => id)
    .sort();
}

/** Every secret test.yml reads is passed by the queue or read only by a nightly-only job. */
function assertSecrets(mergeQueueSource, nightlySource) {
  const nightly = parseYaml(nightlySource);
  const passed = Object.keys(parseYaml(mergeQueueSource).jobs[CALL].secrets ?? {});
  const skipped = new Set(nightlyOnlyJobs(nightlySource));
  const read = (value) =>
    [...JSON.stringify(value ?? {}).matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/gu)].map(
      ([, name]) => name
    );
  const declared = nightly.on.workflow_call?.secrets ?? {};
  for (const name of passed) {
    assert.ok(
      name in declared,
      `the queue passes secrets.${name}, which test.yml does not declare`
    );
  }
  for (const [name, { required }] of Object.entries(declared)) {
    assert.ok(!required || passed.includes(name), `test.yml requires secrets.${name}; pass it`);
  }
  for (const name of read(nightly.env)) {
    assert.ok(
      passed.includes(name),
      `test.yml reads secrets.${name} in every job; the queue must pass it`
    );
  }
  for (const [id, job] of Object.entries(nightly.jobs)) {
    for (const name of read(job)) {
      assert.ok(
        passed.includes(name) || skipped.has(id),
        `test.yml › ${id} reads secrets.${name}, which the queue does not pass; it must skip in the queue`
      );
    }
  }
}

/** A red merge group never files to Linear: filing is schedule-only and the queue has no schedule. */
function assertNoLinearFromTheQueue(mergeQueueSource, nightlySource) {
  assert.equal(
    parseYaml(mergeQueueSource).on.schedule,
    undefined,
    'merge-queue.yml must not run on a schedule'
  );
  const callers = readdirSync(workflowsDir)
    .filter((file) => /\.ya?ml$/u.test(file))
    .filter((file) =>
      Object.values(parseYaml(readWorkflow(file)).jobs ?? {}).some(
        (job) => job.uses === `./.github/workflows/${NIGHTLY}`
      )
    );
  assert.deepEqual(callers, [MERGE_QUEUE], 'only the merge queue may call test.yml');
  for (const [id, job] of Object.entries(parseYaml(nightlySource).jobs)) {
    if (/linear/iu.test(JSON.stringify(job))) {
      assert.ok(
        conjuncts(job.if)?.includes(SCHEDULE_ONLY),
        `test.yml › ${id} talks to Linear, so it must run only on schedule`
      );
    }
  }
}

/** A merge group neither cancels nor is cancelled by a nightly or manual Test run. */
function assertConcurrency(mergeQueueSource, nightlySource) {
  const queue = parseYaml(mergeQueueSource);
  const nightly = parseYaml(nightlySource);
  assert.equal(
    queue.concurrency,
    undefined,
    'the called test.yml owns the run’s concurrency group'
  );
  assert.notEqual(queue.name, nightly.name, 'distinct workflow names keep the groups apart');
  assert.match(
    expression(nightly.concurrency.group),
    /^github\.workflow\b/u,
    'test.yml’s group must start with github.workflow, the caller’s name in a called run'
  );
  assert.equal(
    expression(nightly.concurrency['cancel-in-progress']),
    "github.event_name == 'pull_request'",
    'only a pull_request run may cancel an older one'
  );
}

/** Affected selection and the affected Unit phases run against the merge group's exact commits. */
function assertExactAffectedRange(nightlySource) {
  const jobs = parseYaml(nightlySource).jobs;
  const steps = [
    jobs.static.steps.find(({ id }) => id === 'unit-shards'),
    ...jobs['unit-shard'].steps.filter(({ run }) => / --affected /u.test(run ?? '')),
  ];
  assert.equal(steps.length, 3, 'expected the selection and two affected Unit phases');
  for (const step of steps) {
    assert.equal(step.env?.TURBO_SCM_BASE, AFFECTED_BASE, `${step.name} base`);
    assert.equal(step.env?.TURBO_SCM_HEAD, AFFECTED_HEAD, `${step.name} head`);
  }
  for (const step of steps.slice(1)) {
    assert.equal(
      expression(step.if),
      "github.event_name == 'pull_request' || github.event_name == 'merge_group'",
      `${step.name} must run for a merge group`
    );
  }
}

function judgeStep(source) {
  const step = parseYaml(source).jobs[GATE]?.steps?.find(({ name }) => name === JUDGE_STEP);
  assert.ok(step, `merge-queue.yml › ${GATE} must have a "${JUDGE_STEP}" step`);
  return step;
}

/** The required check judges the call and every job inside it. */
function assertGate(mergeQueueSource, nightlySource) {
  const { jobs } = parseYaml(mergeQueueSource);
  const nightly = parseYaml(nightlySource);
  const gate = jobs[GATE];
  assert.ok(gate, `merge-queue.yml must define ${GATE}`);
  assert.equal(gate.name, GATE_NAME, 'the ruleset requires the gate by this exact name');
  assert.equal(
    expression(gate.if),
    `${FORK_GUARD} && ${SKIPS_PULL_REQUEST} && always()`,
    'the gate must report on every merge group, even when a job fails'
  );
  assert.deepEqual([gate.needs ?? []].flat(), [CALL], 'the gate waits for the call');

  const nightlyJobs = Object.keys(nightly.jobs).sort();
  const outputs = nightly.on.workflow_call?.outputs ?? {};
  for (const id of nightlyJobs) {
    assert.equal(
      outputs[`${id}-result`]?.value,
      actions(`jobs.${id}.result`),
      `test.yml must export ${id}-result for the gate`
    );
  }
  assert.equal(outputs['unit-shard-count']?.value, actions('jobs.static.outputs.unit-shard-count'));

  const env = judgeStep(mergeQueueSource).env ?? {};
  const expected = {
    [`RESULT_${envName(CALL)}`]: actions(`needs.${CALL}.result`),
    ...Object.fromEntries(
      nightlyJobs.map((id) => [
        `RESULT_${envName(id)}`,
        actions(`needs.${CALL}.outputs.${id}-result`),
      ])
    ),
  };
  const judged = Object.fromEntries(
    Object.entries(env).filter(([name]) => name.startsWith('RESULT_'))
  );
  assert.deepEqual(judged, expected, 'the gate must judge the call and every job of test.yml');
  assert.equal(env.UNIT_SHARD_COUNT, actions(`needs.${CALL}.outputs.unit-shard-count`));
  assert.deepEqual(
    String(env.NIGHTLY_ONLY).split(/\s+/u).sort(),
    nightlyOnlyJobs(nightlySource).map(envName).sort(),
    'the gate must expect exactly the nightly-only jobs to skip'
  );
}

/** Runs the gate's verdict script with every job at its expected result unless overridden. */
function runJudge(source, overrides = {}) {
  const step = judgeStep(source);
  const nightlyOnly = String(step.env.NIGHTLY_ONLY).split(/\s+/u);
  const results = Object.fromEntries(
    Object.keys(step.env)
      .filter((name) => name.startsWith('RESULT_'))
      .map((name) => [
        name,
        nightlyOnly.includes(name.slice('RESULT_'.length)) ? 'skipped' : 'success',
      ])
  );
  return spawnSync('bash', ['-c', step.run], {
    encoding: 'utf8',
    env: {
      NIGHTLY_ONLY: step.env.NIGHTLY_ONLY,
      PATH: process.env.PATH,
      ...results,
      UNIT_SHARD_COUNT: '9',
      ...overrides,
    },
  });
}

test('the merge queue runs on merge groups and dispatch, and skips every job on pull_request', () => {
  assertTriggers(readWorkflow(MERGE_QUEUE));
});

test('the fast tier is test.yml itself, passed only TURBO_TOKEN', () => {
  assertCall(readWorkflow(MERGE_QUEUE));
  assertSecrets(readWorkflow(MERGE_QUEUE), readWorkflow(NIGHTLY));
});

test('a merge group never files to Linear', () => {
  assertNoLinearFromTheQueue(readWorkflow(MERGE_QUEUE), readWorkflow(NIGHTLY));
});

test('a merge group shares no concurrency group with a nightly or manual run', () => {
  assertConcurrency(readWorkflow(MERGE_QUEUE), readWorkflow(NIGHTLY));
});

test('affected Unit selection uses the merge group’s exact base and head', () => {
  assertExactAffectedRange(readWorkflow(NIGHTLY));
});

test('the gate judges the call and every job of test.yml', () => {
  assertGate(readWorkflow(MERGE_QUEUE), readWorkflow(NIGHTLY));
});

test('the gate passes only on the expected results, or a Unit matrix Static verified empty', () => {
  const source = readWorkflow(MERGE_QUEUE);
  const first = runJudge(source);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const step = judgeStep(source);
  const nightlyOnly = String(step.env.NIGHTLY_ONLY).split(/\s+/u);
  for (const name of Object.keys(step.env).filter((key) => key.startsWith('RESULT_'))) {
    const wrong = nightlyOnly.includes(name.slice('RESULT_'.length))
      ? ['success', 'failure', 'cancelled', '']
      : ['failure', 'cancelled', 'skipped', ''];
    for (const result of wrong) {
      assert.notEqual(runJudge(source, { [name]: result }).status, 0, `${name}=${result}`);
    }
  }
  const unitSkipped = { RESULT_UNIT_SHARD: 'skipped' };
  assert.equal(runJudge(source, { ...unitSkipped, UNIT_SHARD_COUNT: '0' }).status, 0);
  assert.notEqual(runJudge(source, { ...unitSkipped, UNIT_SHARD_COUNT: '' }).status, 0);
  // Static owns selection: when it fails, Unit is skipped, and that is a failure.
  for (const count of ['', '0']) {
    assert.notEqual(
      runJudge(source, { ...unitSkipped, RESULT_STATIC: 'failure', UNIT_SHARD_COUNT: count })
        .status,
      0,
      `Static failure with Unit skipped and count "${count}"`
    );
  }
});

function mutate(source, from, to) {
  const mutated = source.replace(from, to);
  assert.notEqual(mutated, source, `control mutation ${String(from)} matched nothing`);
  return mutated;
}

test('CONTROL: a push or schedule trigger, or a job that runs on pull_request, fails the trigger check', () => {
  const source = readWorkflow(MERGE_QUEUE);
  for (const trigger of ['push:\n    branches: [main]\n', "schedule:\n    - cron: '0 0 * * *'\n"]) {
    const mutated = mutate(source, '\non:\n', `\non:\n  ${trigger}`);
    assert.throws(() => assertTriggers(mutated), /never on push or a schedule/u);
  }
  const unguardedCall = mutate(
    source,
    `    if: ${FORK_GUARD} && ${SKIPS_PULL_REQUEST}\n    uses:`,
    `    if: ${FORK_GUARD}\n    uses:`
  );
  assert.throws(() => assertTriggers(unguardedCall), /test must skip on pull_request/u);
  const gateOnPullRequests = mutate(
    source,
    `${SKIPS_PULL_REQUEST} && always()`,
    `(${SKIPS_PULL_REQUEST} || always())`
  );
  assert.throws(
    () => assertTriggers(gateOnPullRequests),
    /merge-queue-gate must skip on pull_request/u
  );
});

test('CONTROL: an inherited or extra secret, or an unskipped reader, fails the secrets check', () => {
  const source = readWorkflow(MERGE_QUEUE);
  const nightly = readWorkflow(NIGHTLY);
  const inherited = mutate(source, /secrets:\n {6}TURBO_TOKEN: .*\n/u, 'secrets: inherit\n');
  assert.throws(() => assertCall(inherited), /never inherit/u);
  const unskipped = mutate(nightly, ` && ${SCHEDULE_ONLY} }}`, ' }}');
  assert.throws(
    () => assertSecrets(source, unskipped),
    /notify-linear reads secrets\.LINEAR_API_KEY/u
  );
});

test('CONTROL: a scheduled queue, a second caller or an unscheduled Linear job fails the Linear check', () => {
  const source = readWorkflow(MERGE_QUEUE);
  const nightly = readWorkflow(NIGHTLY);
  const scheduled = mutate(source, '\non:\n', "\non:\n  schedule:\n    - cron: '0 0 * * *'\n");
  assert.throws(
    () => assertNoLinearFromTheQueue(scheduled, nightly),
    /must not run on a schedule/u
  );
  const unscheduled = mutate(nightly, ` && ${SCHEDULE_ONLY} }}`, ' }}');
  assert.throws(
    () => assertNoLinearFromTheQueue(source, unscheduled),
    /notify-linear talks to Linear/u
  );
});

test('CONTROL: a shared group or a wrong affected range fails its check', () => {
  const source = readWorkflow(MERGE_QUEUE);
  const nightly = readWorkflow(NIGHTLY);
  const grouped = mutate(
    source,
    '\npermissions:\n',
    '\nconcurrency:\n  group: queue\n\npermissions:\n'
  );
  assert.throws(() => assertConcurrency(grouped, nightly), /owns the run/u);
  const renamed = mutate(source, 'name: Merge Queue\n', 'name: Test\n');
  assert.throws(() => assertConcurrency(renamed, nightly), /distinct workflow names/u);
  const headless = mutate(nightly, AFFECTED_HEAD, actions('github.sha'));
  assert.throws(() => assertExactAffectedRange(headless), /head/u);
});

test('CONTROL: a job the gate does not judge, or a wrong skip list, fails the gate check', () => {
  const source = readWorkflow(MERGE_QUEUE);
  const nightly = readWorkflow(NIGHTLY);
  const unjudged = mutate(source, /^ {10}RESULT_WEB_E2E: .*\n/mu, '');
  assert.throws(() => assertGate(unjudged, nightly), /every job of test\.yml/u);
  const unexported = mutate(nightly, /^ {6}web-e2e-result:\n {8}value: .*\n/mu, '');
  assert.throws(() => assertGate(source, unexported), /export web-e2e-result/u);
  const skipList = mutate(
    source,
    'NIGHTLY_ONLY: NATIVE_WINDOWS ',
    'NIGHTLY_ONLY: STATIC NATIVE_WINDOWS '
  );
  assert.throws(() => assertGate(skipList, nightly), /nightly-only jobs to skip/u);
});
