import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * BST-2188 (owner decision 2026-10-19): Mergify's merge queue lands every pull
 * request on main. Mergify tests each batch on a branch it pushes under the
 * queue_branch_prefix in .mergify.yml, and merge-queue.yml runs on exactly
 * those pushes. It calls test.yml with `merge-queue: true`, so the fast tier is
 * the nightly's own Static, Unit, Build and smoke E2E jobs, not a copy of them.
 * Its one gate job is the merge condition in .mergify.yml and the check the
 * ruleset on main requires.
 *
 * No pull request starts merge-queue.yml. GitHub reports a job skipped by its
 * condition as success to required checks, so a skip-only pull_request trigger
 * would satisfy the gate on every PR head; a workflow its branch filter never
 * starts leaves the check pending, and only Mergify, which bypasses the
 * ruleset, can merge.
 *
 * Each check is a function over source text, so the CONTROL tests can mutate
 * the real files and watch the check fail.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const readWorkflow = (file) => readFileSync(path.join(workflowsDir, file), 'utf8');
const readMergify = () => readFileSync(path.join(repoRoot, '.mergify.yml'), 'utf8');
const MERGE_QUEUE = 'merge-queue.yml';
const NIGHTLY = 'test.yml';

const CALL = 'test';
const GATE = 'merge-queue-gate';
const GATE_NAME = 'Merge Queue Gate';
const JUDGE_STEP = 'Judge every job';
const FORK_GUARD = "github.repository == 'seandearnaley/brainstrike'";
// Deleting a branch fires push too, with the SHA reverted to the default
// branch; Mergify deletes each queue branch once its batch is done.
const SKIPS_DELETION = '!github.event.deleted';
const SCHEDULE_ONLY = "github.event_name == 'schedule'";
const OUTSIDE_THE_QUEUE = '!inputs.merge-queue';
const QUEUE_PREFIX = 'mergify/merge-queue/';
const QUEUE_BATCH = "inputs.merge-queue && github.event_name == 'push'";
const COMPLETE_RUN = "github.event_name != 'push' || !inputs.merge-queue";
const BATCH_BASE = 'affected-base';
const actions = (body) => `${'$'}{{ ${body} }}`;
const UNIT_SELECTION = actions(`${QUEUE_BATCH} && 'affected' || 'complete'`);
const STATIC_BASE = actions(`steps.${BATCH_BASE}.outputs.sha`);
const SHARD_BASE = actions(`needs.static.outputs.${BATCH_BASE}`);
const BATCH_HEAD = actions('github.sha');
const GATE_CONDITION = `check-success = @github-actions/${GATE_NAME}`;

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
  assert.deepEqual(
    Object.keys(on).sort(),
    ['push', 'workflow_dispatch'],
    'merge-queue.yml must run on Mergify queue branches and manual dispatch, never on pull_request, merge_group or a schedule'
  );
  assert.deepEqual(
    on.push,
    { branches: [`${QUEUE_PREFIX}**`] },
    'merge-queue.yml may run on push only for the branches Mergify pushes its batches to'
  );
  for (const [id, job] of Object.entries(jobs)) {
    assert.ok(
      conjuncts(job.if)?.includes(SKIPS_DELETION),
      `merge-queue.yml › ${id} must skip a queue branch's deletion: its if: needs a top-level "&& ${SKIPS_DELETION}" and no "||"`
    );
  }
}

/** The queue lands only through this gate, on the branches the workflow runs on. */
function assertMergify(mergifySource) {
  const config = parseYaml(mergifySource);
  assert.deepEqual(
    Object.keys(config).sort(),
    ['merge_queue', 'queue_rules'],
    'Mergify bypasses the ruleset, so it may merge only through this queue: no pull_request_rules merge, no auto-merge'
  );
  assert.deepEqual(
    config.merge_queue,
    { max_parallel_checks: 1 },
    'one batch under test at a time, so each batch is built on main itself'
  );
  assert.equal(config.queue_rules.length, 1, '.mergify.yml must define one queue');
  const [rule] = config.queue_rules;
  assert.deepEqual(
    Object.keys(rule).sort(),
    [
      'batch_size',
      'branch_protection_injection_mode',
      'checks_timeout',
      'merge_conditions',
      'merge_method',
      'name',
      'queue_branch_prefix',
      'queue_conditions',
    ],
    'every queue option is pinned here'
  );
  assert.deepEqual(
    rule.merge_conditions,
    [GATE_CONDITION],
    `a batch may merge only when GitHub Actions reported ${GATE_NAME} success on it`
  );
  assert.equal(
    rule.queue_branch_prefix,
    QUEUE_PREFIX,
    'merge-queue.yml runs on pushes under this prefix'
  );
  assert.deepEqual(rule.queue_conditions, ['base = main'], 'the queue lands on main only');
  assert.equal(
    rule.branch_protection_injection_mode,
    'merge',
    'the required gate never reports on a PR head, so it must gate the merge, not queue entry'
  );
  assert.equal(rule.merge_method, 'squash', 'squash keeps main linear');
  assert.equal(rule.batch_size, 5);
  assert.equal(rule.checks_timeout, '60 min');
  assert.equal(rule.name, 'default');
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

/** A red batch never files to Linear: filing is schedule-only and the queue has no schedule. */
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

/** A batch neither cancels nor is cancelled by a nightly or manual Test run. */
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

function batchBaseStep(nightlySource) {
  const step = parseYaml(nightlySource).jobs.static.steps.find(({ id }) => id === BATCH_BASE);
  assert.ok(step, `test.yml › static must have the "${BATCH_BASE}" step`);
  return step;
}

/**
 * A batch selects and runs affected Unit work against the main commit it was
 * built on and the exact commit Mergify pushed; every other run is complete.
 */
function assertExactAffectedRange(nightlySource) {
  const { jobs } = parseYaml(nightlySource);
  const steps = jobs.static.steps;
  const base = batchBaseStep(nightlySource);
  const selection = steps.find(({ id }) => id === 'unit-shards');
  assert.ok(
    steps.indexOf(base) < steps.indexOf(selection),
    'Static resolves the batch base before it selects Unit shards'
  );
  assert.equal(expression(base.if), QUEUE_BATCH, 'the base resolves exactly for a queue batch');
  assert.equal(jobs.static.outputs?.[BATCH_BASE], STATIC_BASE, 'Static exports the batch base');
  assert.equal(selection.env?.UNIT_SELECTION, UNIT_SELECTION, 'only a queue batch is affected');
  assert.equal(selection.env?.TURBO_SCM_BASE, STATIC_BASE, 'selection base');
  assert.equal(selection.env?.TURBO_SCM_HEAD, BATCH_HEAD, 'selection head');
  const shardSteps = jobs['unit-shard'].steps;
  const affected = shardSteps.filter(({ run }) => / --affected /u.test(run ?? ''));
  const complete = shardSteps.filter(({ run }) => /matrix\.push_filters/u.test(run ?? ''));
  assert.equal(affected.length, 2, 'expected the two affected Unit phases');
  assert.equal(complete.length, 2, 'expected the two complete Unit phases');
  for (const step of affected) {
    assert.equal(expression(step.if), QUEUE_BATCH, `${step.name} must run exactly for a batch`);
    assert.equal(step.env?.TURBO_SCM_BASE, SHARD_BASE, `${step.name} base`);
    assert.equal(step.env?.TURBO_SCM_HEAD, BATCH_HEAD, `${step.name} head`);
  }
  for (const step of complete) {
    assert.equal(expression(step.if), COMPLETE_RUN, `${step.name} must run for every other run`);
  }
}

/** Runs the base step's script in a repository shaped like a Mergify queue branch. */
function runBaseStep(nightlySource, t) {
  const repo = mkdtempSync(path.join(tmpdir(), 'merge-queue-base-'));
  t.after(() => rmSync(repo, { force: true, recursive: true }));
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-10-19T00:00:00Z',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_AUTHOR_NAME: 'test',
        GIT_COMMITTER_DATE: '2026-10-19T00:00:00Z',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
      },
    }).trim();
  const commit = (message) => {
    writeFileSync(path.join(repo, 'file.txt'), `${message}\n`);
    git('add', 'file.txt');
    git('commit', '--quiet', '--no-gpg-sign', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet', '--initial-branch=main');
  const older = commit('older main');
  // A queued pull request branched from an older main.
  git('switch', '--quiet', '-c', 'feature');
  writeFileSync(path.join(repo, 'feature.txt'), 'feature\n');
  git('add', 'feature.txt');
  git('commit', '--quiet', '--no-gpg-sign', '-m', 'feature');
  git('switch', '--quiet', 'main');
  const built = commit('main the batch is built on');
  // Mergify's queue branch: main plus a merge of each queued pull request.
  git('switch', '--quiet', '-c', 'mergify/merge-queue/0123456789');
  git('merge', '--quiet', '--no-ff', '--no-gpg-sign', '-m', 'Merge of #1', 'feature');
  // main moves on while the batch runs; the base must not follow it.
  git('switch', '--quiet', 'main');
  commit('main after the batch was built');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('switch', '--quiet', '--detach', 'mergify/merge-queue/0123456789');
  const output = path.join(repo, 'github-output');
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-c', batchBaseStep(nightlySource).run], {
    cwd: repo,
    encoding: 'utf8',
    env: { GITHUB_OUTPUT: output, PATH: process.env.PATH },
  });
  return { built, older, output: readFileSync(output, 'utf8'), result };
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
  assert.equal(gate.name, GATE_NAME, '.mergify.yml and the ruleset require the gate by this name');
  assert.equal(
    expression(gate.if),
    `${FORK_GUARD} && ${SKIPS_DELETION} && always()`,
    'the gate must report on every batch, even when a job fails'
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

test('the merge queue runs only on Mergify queue branches and dispatch, never for a pull request', () => {
  assertTriggers(readWorkflow(MERGE_QUEUE));
});

test('.mergify.yml lands each batch only on Merge Queue Gate success, squashed onto main', () => {
  assertMergify(readMergify());
});

test('the fast tier is test.yml itself, passed only TURBO_TOKEN', () => {
  assertCall(readWorkflow(MERGE_QUEUE));
  assertSecrets(readWorkflow(MERGE_QUEUE), readWorkflow(NIGHTLY));
});

test('a queue batch never files to Linear', () => {
  assertNoLinearFromTheQueue(readWorkflow(MERGE_QUEUE), readWorkflow(NIGHTLY));
});

test('a queue batch shares no concurrency group with a nightly or manual run', () => {
  assertConcurrency(readWorkflow(MERGE_QUEUE), readWorkflow(NIGHTLY));
});

test('affected Unit selection uses the batch’s main base and its exact head', () => {
  assertExactAffectedRange(readWorkflow(NIGHTLY));
});

test('the batch base is the main commit the batch was built on, even after main moves', (t) => {
  const { built, older, output, result } = runBaseStep(readWorkflow(NIGHTLY), t);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.notEqual(built, older);
  assert.equal(output, `sha=${built}\n`);
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

test('CONTROL: a pull request, merge group or schedule trigger, a wider push or a deletion run fails the trigger check', () => {
  const source = readWorkflow(MERGE_QUEUE);
  for (const trigger of [
    'pull_request:\n    branches: [main]\n',
    'merge_group:\n    types: [checks_requested]\n',
    "schedule:\n    - cron: '0 0 * * *'\n",
  ]) {
    const mutated = mutate(source, '\non:\n', `\non:\n  ${trigger}`);
    assert.throws(
      () => assertTriggers(mutated),
      /never on pull_request, merge_group or a schedule/u
    );
  }
  for (const branches of ["['**']", '[main]', "['mergify/**']"]) {
    const widened = mutate(source, `branches: ['${QUEUE_PREFIX}**']`, `branches: ${branches}`);
    assert.throws(() => assertTriggers(widened), /only for the branches Mergify pushes/u);
  }
  const onDeletion = mutate(
    source,
    `${FORK_GUARD} && ${SKIPS_DELETION}\n    uses:`,
    `${FORK_GUARD}\n    uses:`
  );
  assert.throws(() => assertTriggers(onDeletion), /test must skip a queue branch's deletion/u);
});

test('CONTROL: a missing or loosened merge condition, or another way to merge, fails the Mergify check', () => {
  const source = readMergify();
  const conditionLine = `      - ${GATE_CONDITION}\n`;
  const missing = mutate(source, conditionLine, '');
  assert.throws(() => assertMergify(missing), /only when GitHub Actions reported/u);
  const anyApp = mutate(source, conditionLine, `      - check-success = ${GATE_NAME}\n`);
  assert.throws(() => assertMergify(anyApp), /only when GitHub Actions reported/u);
  const extra = mutate(source, conditionLine, `${conditionLine}      - label = urgent\n`);
  assert.throws(() => assertMergify(extra), /only when GitHub Actions reported/u);
  const autoMerge = `${source}\npull_request_rules:\n  - name: merge\n    conditions: []\n    actions:\n      merge:\n`;
  assert.throws(() => assertMergify(autoMerge), /may merge only through this queue/u);
  const elsewhere = mutate(
    source,
    `queue_branch_prefix: ${QUEUE_PREFIX}`,
    'queue_branch_prefix: mq/'
  );
  assert.throws(() => assertMergify(elsewhere), /runs on pushes under this prefix/u);
  const queueEntry = mutate(
    source,
    'branch_protection_injection_mode: merge',
    'branch_protection_injection_mode: queue'
  );
  assert.throws(() => assertMergify(queueEntry), /gate the merge, not queue entry/u);
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

test('CONTROL: a shared group, a wrong affected range or a moving base fails its check', (t) => {
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
  const complete = mutate(nightly, `${QUEUE_BATCH} && 'affected'`, `${QUEUE_BATCH} && 'complete'`);
  assert.throws(() => assertExactAffectedRange(complete), /only a queue batch is affected/u);
  const shardBase = mutate(nightly, `TURBO_SCM_BASE: ${SHARD_BASE}`, 'TURBO_SCM_BASE: origin/main');
  assert.throws(() => assertExactAffectedRange(shardBase), /base/u);
  const tip = mutate(
    nightly,
    'git merge-base HEAD refs/remotes/origin/main',
    'git rev-parse refs/remotes/origin/main'
  );
  const moved = runBaseStep(tip, t);
  assert.equal(moved.result.status, 0, moved.result.stderr);
  assert.notEqual(moved.output, `sha=${moved.built}\n`, 'the main tip is not the batch base');
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
