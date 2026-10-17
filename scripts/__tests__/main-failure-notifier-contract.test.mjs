import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * BST-1301, revised by BST-2066: a red `main` must announce itself.
 *
 * Per-PR and push CI are off (owner decision 2026-10-17), so test.yml's
 * scheduled run is the check that re-evaluates `main` after merges. Its verdict
 * goes to Linear through the shared nightly-linear-alert.yml workflow. The
 * push-only `main-broken` GitHub issue notifier is gone: Linear `nightly-alert`
 * is the one tracker for a red `main`.
 *
 * Each check is control-tested: a mutated workflow must make it throw.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const readWorkflow = (file) => readFileSync(path.join(workflowsDir, file), 'utf8');

const ALERT_WORKFLOW = './.github/workflows/nightly-linear-alert.yml';
/** The deterministic verdicts BST-1301 watched; a red one is always real. */
const WATCHED_JOBS = ['static', 'unit', 'build'];

function assertNightlyMainCheck(source) {
  const { on } = parseYaml(source);
  assert.equal(on?.schedule?.length, 1, 'test.yml must re-check main on a schedule.');
  assert.equal(on.push, undefined, 'test.yml must not run on push.');
}

function assertLinearNotifier(source) {
  const notify = parseYaml(source).jobs?.['notify-linear'];
  assert.ok(notify, 'test.yml must define notify-linear.');
  assert.equal(notify.uses, ALERT_WORKFLOW, 'test.yml must file through the shared alert.');
  assert.match(notify.if, /always\(\) && github\.event_name == 'schedule'/u);
  for (const jobId of WATCHED_JOBS) {
    assert.ok(notify.needs.includes(jobId), `notify-linear must report ${jobId}.`);
  }
}

function assertNoPushNotifier(file, source) {
  for (const [id, job] of Object.entries(parseYaml(source).jobs ?? {})) {
    assert.doesNotMatch(
      String(job.if ?? ''),
      /github\.event_name == 'push'/u,
      `${file} › ${id} is gated on a push event that no workflow receives.`
    );
    const script = (job.steps ?? []).map((step) => step.run ?? '').join('\n');
    assert.doesNotMatch(
      script,
      /gh issue (create|close)|main-broken/u,
      `${file} › ${id} files a second red-main tracker beside Linear.`
    );
  }
}

const workflowFiles = () => readdirSync(workflowsDir).filter((file) => /\.ya?ml$/u.test(file));

test('test.yml re-checks main every night', () => {
  assertNightlyMainCheck(readWorkflow('test.yml'));
});

test('test.yml files its nightly verdict through the shared Linear alert', () => {
  assertLinearNotifier(readWorkflow('test.yml'));
});

test('no push-only notifier or second red-main tracker remains', () => {
  for (const file of workflowFiles()) {
    assertNoPushNotifier(file, readWorkflow(file));
  }
});

function mutate(source, from, to) {
  const mutated = source.replace(from, to);
  assert.notEqual(mutated, source, `control mutation ${String(from)} matched nothing`);
  return mutated;
}

test('CONTROL: dropping the schedule FAILS this contract', () => {
  const mutated = mutate(
    readWorkflow('test.yml'),
    / {2}schedule:\n {4}- cron: '[^']+'\n/u,
    '  push:\n    branches: [main]\n'
  );
  assert.throws(() => assertNightlyMainCheck(mutated), /re-check main on a schedule/u);
});

test('CONTROL: a notifier that stops watching Static FAILS this contract', () => {
  const mutated = mutate(
    readWorkflow('test.yml'),
    'needs: [admission, static, unit-shard, unit, build,',
    'needs: [admission, unit-shard, unit, build,'
  );
  assert.throws(() => assertLinearNotifier(mutated), /must report static/u);
});

test('CONTROL: restoring the push-gated GitHub issue notifier FAILS this contract', () => {
  const restored = `${readWorkflow('test.yml')}
  notify-main-failure:
    needs: [static, unit, build]
    if: >-
      !cancelled() &&
      github.event_name == 'push' &&
      needs.static.result == 'failure'
    runs-on: ubuntu-latest
    steps:
      - run: gh issue create --label "main-broken"
`;
  assert.throws(() => assertNoPushNotifier('test.yml', restored), /gated on a push event/u);
  const ungated = restored.replace("      github.event_name == 'push' &&\n", '');
  assert.throws(() => assertNoPushNotifier('test.yml', ungated), /second red-main tracker/u);
});
