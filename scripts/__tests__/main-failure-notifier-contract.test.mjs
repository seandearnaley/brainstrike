import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * BST-1301: a red `main` must announce itself.
 *
 * `main` broke twice on 2026-08-15 in the same structural way, and both times
 * the breakage was found only because an unrelated PR tripped over it hours
 * later. The gate was never missing — test.yml has always subscribed to
 * `push: branches: [main]`, and Static failed correctly on runs 31872259629,
 * 31872457744 and 31894054632. What was missing was the announcement.
 *
 * This contract pins the two halves that make that detection real:
 *   1. the workflow still runs on pushes to `main` at all (without this the
 *      notifier below can never fire, and the whole thing is decorative), and
 *   2. the notifier stays wired to the deterministic verdicts, push-scoped,
 *      cheap, and off the paid runner pool.
 *
 * Per the BST-836 discipline the guard is control-tested: a synthetic workflow
 * with the notifier's `static` dependency removed must make the assertion
 * throw. A guard never observed failing is not evidence.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'test.yml');

const NOTIFIER = 'notify-main-failure';

/** The deterministic required checks. A red one of these is always real. */
const WATCHED_JOBS = ['static', 'unit', 'build'];

function workflowSource() {
  return readFileSync(workflowPath, 'utf8');
}

function notifier(source = workflowSource()) {
  const workflow = parseYaml(source);
  const job = workflow.jobs?.[NOTIFIER];
  assert.ok(job, `test.yml must define the "${NOTIFIER}" job.`);
  return job;
}

test('test.yml still runs against every commit pushed to main', () => {
  // The precondition for everything else here. If this trigger is ever
  // dropped, nothing evaluates `main` post-merge and the notifier below
  // becomes unreachable rather than merely quiet.
  const workflow = parseYaml(workflowSource());
  const push = workflow.on?.push;
  assert.ok(push, 'test.yml must subscribe to push events.');
  assert.deepEqual(push.branches, ['main']);
});

test('the notifier watches the deterministic verdicts, and only on a real failure', () => {
  const job = notifier();

  assert.deepEqual(
    [...job.needs].sort(),
    [...WATCHED_JOBS].sort(),
    'the notifier must fan in from exactly the deterministic required checks.'
  );

  const condition = job.if;
  assert.match(condition, /always\(\)/, 'without always() the job skips when a need fails.');
  assert.match(
    condition,
    /github\.event_name == 'push'/,
    'the notifier is for merged commits; PR authors already see their own red checks.'
  );
  for (const jobId of WATCHED_JOBS) {
    assert.match(
      condition,
      new RegExp(`needs\\.${jobId}\\.result == 'failure'`),
      `${jobId} must be able to trigger the notification.`
    );
  }
  // `!= 'success'` would page on cancelled and skipped runs, which carry no
  // verdict about the code. A canary that cries wolf gets muted, which is the
  // exact failure this job exists to prevent.
  assert.doesNotMatch(
    condition,
    /result != 'success'/,
    'only a genuine failure may open an issue; cancelled runs carry no verdict.'
  );
});

test('the notifier can file an issue, stays cheap, and never touches the paid pool', () => {
  const job = notifier();

  assert.equal(job.permissions?.issues, 'write', 'the notifier must be able to open an issue.');
  assert.equal(job.permissions?.contents, 'read');

  // The workflow-level default is read-only, so the elevation above must be
  // job-scoped — the same shape the four existing notify-failure jobs use.
  const workflow = parseYaml(workflowSource());
  assert.equal(workflow.permissions?.issues, undefined);

  assert.ok(
    typeof job['timeout-minutes'] === 'number' && job['timeout-minutes'] <= 10,
    'a hung gh API call must not burn the six-hour GitHub Actions default.'
  );
  assert.doesNotMatch(
    String(job['runs-on']),
    /^ubicloud/,
    'the Ubicloud contract is limited to the five measured jobs; a notifier is not one.'
  );

  const steps = job.steps ?? [];
  assert.ok(steps.length > 0, 'the notifier must actually do something.');
  for (const step of steps) {
    assert.ok(typeof step.run === 'string', 'notifier steps are plain gh invocations.');
  }
  const script = steps.map((step) => step.run).join('\n');
  assert.match(script, /gh issue create/, 'a first failure must open a tracking issue.');
  assert.match(script, /gh issue comment/, 'a repeat failure must comment, not open a duplicate.');
  assert.match(script, /--label "main-broken"/, 'the de-duplication key must stay stable.');
});

test('CONTROL: dropping a watched job from the notifier FAILS this contract', () => {
  const source = workflowSource();
  const mutated = source.replace('needs: [static, unit, build]', 'needs: [unit, build]');
  assert.notEqual(
    mutated,
    source,
    'the control mutation matched nothing in test.yml — the control would be vacuous.'
  );

  assert.throws(
    () => {
      const job = notifier(mutated);
      assert.deepEqual([...job.needs].sort(), [...WATCHED_JOBS].sort());
    },
    /Expected values to be strictly deep-equal/,
    'a notifier that stopped watching Static must FAIL this contract.'
  );
});
