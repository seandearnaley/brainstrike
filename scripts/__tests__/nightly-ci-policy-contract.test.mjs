import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * BST-2066 (owner decision 2026-10-17): hosted CI runs on a schedule against
 * main and files every red night to Linear (`nightly-alert`). Per-PR and
 * per-push hosted CI stays off; merges use the local gate.
 *
 * Each check is a function over source text, so the CONTROL tests at the end
 * can mutate the real files and watch the check fail.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const readWorkflow = (file) => read(`.github/workflows/${file}`);

const FORK_GUARD = "github.repository == 'seandearnaley/brainstrike'";
const ALERT_WORKFLOW = './.github/workflows/nightly-linear-alert.yml';
const ALERT_GATE = "always() && github.event_name == 'schedule'";

const SCHEDULED = new Map([
  ['actions-storage-cleanup.yml', '17 5 * * *'],
  ['agent-evals.yml', '13 8 * * *'],
  ['desktop-e2e.yml', '53 7 * * *'],
  ['knip.yml', '37 6 * * 1'],
  ['mcp-verification.yml', '23 8 * * *'],
  ['native-package-matrix.yml', '41 9 * * *'],
  ['nightly-coverage.yml', '17 8 * * *'],
  ['performance.yml', '23 7 * * *'],
  ['test.yml', '3 7 * * *'],
  ['web-e2e.yml', '37 7 * * *'],
]);
const STAYS_DISABLED = [
  'claude-code-review.yml',
  'claude.yml',
  'coverage.yml',
  'local-desktop-e2e.yml',
  'react-doctor.yml',
  'release.yml',
];
const REUSABLE = ['nightly-linear-alert.yml'];
// BST-2188: the merge queue's fast tier. merge-queue-contract.test.mjs owns its
// triggers, its call into test.yml, its gate and .mergify.yml; a red batch
// removes the PR from Mergify's queue, so it files nothing to Linear.
const MERGE_QUEUE = ['merge-queue.yml'];
// Narrow allowances, both BST-2188 (owner decisions 2026-10-19), each proven by
// merge-queue-contract.test.mjs:
// - test.yml may also be called (`workflow_call`), only by merge-queue.yml, so
//   the queue runs the nightly's own jobs rather than copies of them;
// - merge-queue.yml may trigger on push, only for the branches Mergify pushes
//   each queue batch to. No pull request starts it, so its required gate never
//   reports on a PR head and no runner starts for one.
const CALLED_BY = new Map([['test.yml', 'merge-queue.yml']]);
const QUEUE_PUSH = new Map([['merge-queue.yml', { branches: ['mergify/merge-queue/**'] }]]);

const POLICY_LINE =
  '# Per-PR hosted CI is off; merges use the local gate in docs/agents/ci-quality.md.';
const DISABLED_HEADER = [
  '# Cloud CI is disabled due to cost; repository GitHub Actions is disabled.',
  '# Preserved workflow definition only: do not enable, dispatch, or rerun it.',
  '# Test locally with pnpm check and report the commands and results.',
  '# Tell the user: CI is disabled due to cost; validation must run locally.',
  '# Stays disabled: per-PR hosted CI is off.',
];

const AGENTS_POLICY =
  'Per-PR CI is off due to cost; validate locally before merge. Hosted CI runs nightly on main and files failures to Linear (`nightly-alert`).';
const AGENTS_AUTHORIZATION =
  "Do not enable workflows, dispatch hosted checks, request automated reviews, sign or publish without the owner's authorization.";
const NIGHTLY_ALERT_ACTION = 'Treat an open `nightly-alert` issue as a red main: fix main first';
const RETIRED_POLICY = /CI is disabled due to cost; validation must run locally/u;

const actions = (body) => `${'$'}{{ ${body} }}`;
const normalize = (text) => String(text).replace(/\s+/gu, ' ').trim();
const expression = (value) =>
  normalize(value)
    .replace(/^\$\{\{\s*/u, '')
    .replace(/\s*\}\}$/u, '');
const needsOf = (job) => [job.needs ?? []].flat();
const cadence = (cron) => (cron.split(' ')[4] === '*' ? 'nightly' : 'weekly');

function assertScheduleOnly(file, source) {
  const { on } = parseYaml(source);
  assert.deepEqual(
    Object.keys(on).sort(),
    ['schedule', ...(CALLED_BY.has(file) ? ['workflow_call'] : []), 'workflow_dispatch'],
    `${file} must run only on its schedule and manual dispatch`
  );
  assert.deepEqual(on.schedule, [{ cron: SCHEDULED.get(file) }], `${file} schedule`);
}

function assertScheduledHeader(file, source) {
  const [first, second] = source.split('\n');
  assert.equal(
    first,
    `# Runs ${cadence(SCHEDULED.get(file))} on main (owner decision 2026-10-17).`,
    `${file} header`
  );
  assert.equal(second, POLICY_LINE, `${file} header`);
  assert.doesNotMatch(source, /Cloud CI is disabled|Preserved workflow definition/u, file);
}

function assertDisabledHeader(file, source) {
  assert.deepEqual(source.split('\n').slice(0, DISABLED_HEADER.length), DISABLED_HEADER, file);
}

/**
 * A job with no `needs` starts the run, and a job gated on always() or
 * cancelled() runs even when its needs were skipped; both must lead with the
 * fork guard. Every other job is skipped when the job it needs is skipped.
 */
function assertForkGuard(file, source) {
  for (const [id, job] of Object.entries(parseYaml(source).jobs)) {
    const condition = expression(job.if ?? '');
    if (needsOf(job).length > 0 && !/always\(\)|cancelled\(\)/u.test(condition)) {
      continue;
    }
    assert.ok(
      condition === FORK_GUARD || condition.startsWith(`${FORK_GUARD} && `),
      `${file} › ${id} must lead its if: with ${FORK_GUARD}`
    );
  }
}

/**
 * The notifier reports every job it waits on, and every other job reaches it
 * directly or through an always() fan-in that judges its result.
 */
function assertLinearFiling(file, source) {
  const { jobs } = parseYaml(source);
  const notify = jobs['notify-linear'];
  assert.ok(notify, `${file} must define notify-linear`);
  assert.equal(notify.uses, ALERT_WORKFLOW, `${file} › notify-linear`);
  assert.equal(expression(notify.if), `${FORK_GUARD} && ${ALERT_GATE}`, `${file} › notify-linear`);
  assert.equal(notify.with?.workflow_name, actions('github.workflow'), `${file} › notify-linear`);
  assert.equal(
    notify.secrets?.LINEAR_API_KEY,
    actions('secrets.LINEAR_API_KEY'),
    `${file} › notify-linear`
  );
  const needs = needsOf(notify);
  assert.equal(
    notify.with?.results,
    needs.map((id) => `${id}=${actions(`needs.${id}.result`)}`).join(','),
    `${file} › notify-linear must report exactly the jobs it needs`
  );
  const judged = new Set(needs);
  for (const id of needs) {
    if (/always\(\)/u.test(expression(jobs[id].if ?? ''))) {
      for (const upstream of needsOf(jobs[id])) {
        judged.add(upstream);
      }
    }
  }
  for (const id of Object.keys(jobs)) {
    assert.ok(id === 'notify-linear' || judged.has(id), `${file} › ${id} never reaches Linear`);
  }
}

function assertPolicyText(agents, ciQuality) {
  assert.ok(normalize(agents).includes(AGENTS_POLICY), 'AGENTS.md states the nightly policy');
  assert.ok(
    normalize(agents).includes(AGENTS_AUTHORIZATION),
    'AGENTS.md keeps enabling workflows owner-only'
  );
  const [, firstParagraph] = ciQuality.split(/\n\n/u);
  assert.ok(normalize(firstParagraph).includes(AGENTS_POLICY), 'ci-quality.md states the policy');
  assert.ok(
    normalize(firstParagraph).includes(NIGHTLY_ALERT_ACTION),
    'ci-quality.md says what a nightly-alert issue asks for'
  );
  for (const [name, text] of [
    ['AGENTS.md', agents],
    ['ci-quality.md', ciQuality],
  ]) {
    assert.doesNotMatch(text, RETIRED_POLICY, `${name} still states the retired policy`);
  }
}

test('every workflow file has a declared CI role', () => {
  const files = readdirSync(workflowsDir).filter((file) => /\.ya?ml$/u.test(file));
  assert.deepEqual(
    files.sort(),
    [...SCHEDULED.keys(), ...STAYS_DISABLED, ...REUSABLE, ...MERGE_QUEUE].sort()
  );
});

test('scheduled workflows run only on schedule and dispatch, under the nightly header', () => {
  for (const file of SCHEDULED.keys()) {
    const source = readWorkflow(file);
    assertScheduleOnly(file, source);
    assertScheduledHeader(file, source);
  }
});

function assertDistinctSlots(schedules) {
  const byMinute = new Map();
  for (const [file, cron] of schedules) {
    const [minute, hour] = cron.split(' ');
    const slot = `${hour}:${minute}`;
    assert.ok(
      !byMinute.has(slot),
      `${file} shares the ${slot} UTC slot with ${byMinute.get(slot)}`
    );
    byMinute.set(slot, file);
  }
}

test('scheduled workflows start in distinct UTC slots', () => {
  assertDistinctSlots(SCHEDULED);
});

test('CONTROL: two workflows in one cron slot fail the slot check', () => {
  const clashing = new Map([
    ...SCHEDULED,
    ['agent-evals.yml', SCHEDULED.get('nightly-coverage.yml')],
  ]);
  assert.throws(() => assertDistinctSlots(clashing), /shares the 8:17 UTC slot/u);
});

test('PR, bot and manual workflows keep their triggers and say they stay disabled', () => {
  for (const file of STAYS_DISABLED) {
    assertDisabledHeader(file, readWorkflow(file));
  }
  const prTriggered = STAYS_DISABLED.filter(
    (file) => parseYaml(readWorkflow(file)).on.pull_request
  );
  assert.deepEqual(prTriggered, ['claude-code-review.yml', 'coverage.yml', 'react-doctor.yml']);
});

const workflowFiles = () => readdirSync(workflowsDir).filter((file) => /\.ya?ml$/u.test(file));
const allWorkflows = () => new Map(workflowFiles().map((file) => [file, readWorkflow(file)]));
const DISABLED_PULL_REQUEST = ['claude-code-review.yml', 'coverage.yml', 'react-doctor.yml'];
const DISABLED_PUSH = ['react-doctor.yml'];

const triggeredBy = (sources, event) =>
  [...sources]
    .filter(([, source]) => parseYaml(source).on?.[event] !== undefined)
    .map(([file]) => file)
    .sort();

function assertPullRequestTriggers(sources) {
  assert.deepEqual(
    triggeredBy(sources, 'pull_request'),
    DISABLED_PULL_REQUEST,
    'a new pull_request trigger needs its own owner decision'
  );
}

function assertPushTriggers(sources) {
  assert.deepEqual(
    triggeredBy(sources, 'push'),
    [...DISABLED_PUSH, ...QUEUE_PUSH.keys()].sort(),
    'a new push trigger needs its own owner decision'
  );
  for (const [file, push] of QUEUE_PUSH) {
    assert.deepEqual(
      parseYaml(sources.get(file)).on.push,
      push,
      `${file} may run on push only for Mergify queue branches`
    );
  }
}

function assertCallers(sources) {
  for (const [callee, caller] of CALLED_BY) {
    const callers = [...sources]
      .filter(([, source]) =>
        Object.values(parseYaml(source).jobs ?? {}).some(
          (job) => job.uses === `./.github/workflows/${callee}`
        )
      )
      .map(([file]) => file);
    assert.deepEqual(callers, [caller], `${callee} may be called only by ${caller}`);
  }
}

test('only the disabled PR workflows trigger on pull_request', () => {
  assertPullRequestTriggers(allWorkflows());
});

test('beside a disabled workflow, only the merge queue triggers on push, for its queue branches', () => {
  assertPushTriggers(allWorkflows());
});

test('test.yml is called only by the merge queue', () => {
  assertCallers(allWorkflows());
});

test('no scheduled or merge-queue job can start in a fork', () => {
  for (const file of [...SCHEDULED.keys(), ...MERGE_QUEUE]) {
    assertForkGuard(file, readWorkflow(file));
  }
});

test('every scheduled run files its verdict to Linear', () => {
  for (const file of SCHEDULED.keys()) {
    assertLinearFiling(file, readWorkflow(file));
  }
  const testJobs = parseYaml(readWorkflow('test.yml')).jobs;
  assert.deepEqual(
    needsOf(testJobs['notify-linear']).sort(),
    Object.keys(testJobs)
      .filter((id) => id !== 'notify-linear')
      .sort(),
    'test.yml reports every job result directly'
  );
});

test('AGENTS.md and ci-quality.md state the nightly policy', () => {
  assertPolicyText(read('AGENTS.md'), read('docs/agents/ci-quality.md'));
});

function mutate(source, from, to) {
  const mutated = source.replace(from, to);
  assert.notEqual(mutated, source, `control mutation ${String(from)} matched nothing`);
  return mutated;
}

test('CONTROL: re-adding a pull_request or push trigger fails the trigger check', () => {
  const source = readWorkflow('test.yml');
  for (const trigger of [
    'pull_request:\n    branches: [main]\n',
    'push:\n    branches: [main]\n',
  ]) {
    const mutated = mutate(source, '\non:\n', `\non:\n  ${trigger}`);
    assert.throws(() => assertScheduleOnly('test.yml', mutated), /schedule and manual dispatch/u);
  }
});

test('CONTROL: the retired header fails the header check', () => {
  const source = readWorkflow('web-e2e.yml');
  const mutated = mutate(source, POLICY_LINE, '# Cloud CI is disabled due to cost.');
  assert.throws(() => assertScheduledHeader('web-e2e.yml', mutated), /header/u);
  assert.throws(
    () => assertDisabledHeader('coverage.yml', mutate(readWorkflow('coverage.yml'), /^.*\n/u, '')),
    /coverage\.yml/u
  );
});

test('CONTROL: an unguarded root or always() job fails the fork-guard check', () => {
  const source = readWorkflow('test.yml');
  const root = mutate(source, `    if: ${FORK_GUARD}\n`, '');
  assert.throws(() => assertForkGuard('test.yml', root), /admission must lead/u);
  const fanIn = mutate(source, `${FORK_GUARD} && always() &&`, 'always() &&');
  assert.throws(() => assertForkGuard('test.yml', fanIn), /must lead its if:/u);
});

test('CONTROL: an unreported or unwaited job fails the Linear filing check', () => {
  const source = readWorkflow('mcp-verification.yml');
  const unwaited = mutate(source, 'needs: [verify, official_auth,', 'needs: [official_auth,');
  assert.throws(() => assertLinearFiling('mcp-verification.yml', unwaited), /exactly the jobs/u);
  const unreported = mutate(
    unwaited,
    `results: verify=${actions('needs.verify.result')},`,
    'results: '
  );
  assert.throws(() => assertLinearFiling('mcp-verification.yml', unreported), /verify never/u);
  const ungated = mutate(source, ALERT_GATE, 'always()');
  assert.throws(() => assertLinearFiling('mcp-verification.yml', ungated), /notify-linear/u);
});

test('CONTROL: the retired AGENTS.md sentence fails the policy check', () => {
  const agents = read('AGENTS.md');
  const ciQuality = read('docs/agents/ci-quality.md');
  const retired = mutate(
    agents,
    /Per-PR CI is off due to cost;[\s\S]*?\(`nightly-alert`\)\./u,
    'CI is disabled due to cost; validation must run locally.'
  );
  assert.throws(() => assertPolicyText(retired, ciQuality), /nightly policy/u);
});

test('CONTROL: another pull_request or push trigger, caller or workflow_call fails its allowance check', () => {
  const sources = allWorkflows();
  for (const file of ['knip.yml', 'merge-queue.yml']) {
    const triggered = mutate(sources.get(file), '\non:\n', '\non:\n  pull_request:\n');
    assert.throws(
      () => assertPullRequestTriggers(new Map([...sources, [file, triggered]])),
      /pull_request trigger needs its own owner decision/u,
      file
    );
  }
  const knipPush = mutate(sources.get('knip.yml'), '\non:\n', '\non:\n  push:\n');
  assert.throws(
    () => assertPushTriggers(new Map([...sources, ['knip.yml', knipPush]])),
    /push trigger needs its own owner decision/u
  );
  const mainPush = mutate(
    sources.get('merge-queue.yml'),
    "branches: ['mergify/merge-queue/**']",
    'branches: [main]'
  );
  assert.throws(
    () => assertPushTriggers(new Map([...sources, ['merge-queue.yml', mainPush]])),
    /only for Mergify queue branches/u
  );
  const caller = `${sources.get('knip.yml')}  extra:\n    uses: ./.github/workflows/test.yml\n`;
  assert.throws(
    () => assertCallers(new Map([...sources, ['knip.yml', caller]])),
    /called only by merge-queue\.yml/u
  );
  const callable = mutate(readWorkflow('web-e2e.yml'), '\non:\n', '\non:\n  workflow_call:\n');
  assert.throws(() => assertScheduleOnly('web-e2e.yml', callable), /schedule and manual dispatch/u);
});
