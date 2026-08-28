import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * BST-1301: a red `main` must announce itself, exactly once per incident, and
 * never for a run that tested nothing.
 *
 * `main` broke twice on 2026-08-15 in the same structural way, and both times
 * the breakage was found only because an unrelated PR tripped over it hours
 * later. The gate was never missing — test.yml has always subscribed to
 * `push: branches: [main]`, and Static failed correctly on runs 31872259629,
 * 31872457744 and 31894054632. What was missing was the announcement.
 *
 * This contract pins the halves that make that detection real:
 *   1. the workflow still runs on pushes to `main` at all (without this the
 *      notifier below can never fire, and the whole thing is decorative),
 *   2. the notifier stays wired to the deterministic verdicts, push-scoped,
 *      cheap, and off the paid runner pool,
 *   3. it cannot fire on a CANCELLED run, and
 *   4. green `main` closes the issue, so label-keyed de-duplication tracks one
 *      incident instead of silently absorbing the next one.
 *
 * Per the BST-836 discipline the guards are control-tested: a synthetic
 * workflow with the property removed must make the assertion throw. A guard
 * never observed failing is not evidence.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'test.yml');

const NOTIFIER = 'notify-main-failure';
const RECOVERY = 'notify-main-recovery';

/** The deterministic required checks. A red one of these is always real. */
const WATCHED_JOBS = ['static', 'unit', 'build'];

function workflowSource() {
  return readFileSync(workflowPath, 'utf8');
}

function workflowJob(id, source = workflowSource()) {
  const workflow = parseYaml(source);
  const found = workflow.jobs?.[id];
  assert.ok(found, `test.yml must define the "${id}" job.`);
  return found;
}

/**
 * Drop whole-line `#` comments from a step body. The step below EXPLAINS the
 * `2>/dev/null || true` idiom it refuses to use, so asserting over the raw
 * body would match the prose describing the hazard rather than the command
 * that would cause it.
 */
function executableLines(script) {
  return script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function notifier(source = workflowSource()) {
  return workflowJob(NOTIFIER, source);
}

function recovery(source = workflowSource()) {
  return workflowJob(RECOVERY, source);
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
  const condition = notifier().if;

  assert.deepEqual(
    [...notifier().needs].sort(),
    [...WATCHED_JOBS].sort(),
    'the notifier must fan in from exactly the deterministic required checks.'
  );
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
  // `!= 'success'` would page on skipped runs, which carry no verdict.
  assert.doesNotMatch(
    condition,
    /result != 'success'/,
    'only a genuine failure may open an issue.'
  );
});

test('a cancelled run cannot open an issue', () => {
  // The sharp edge. `== 'failure'` is NECESSARY BUT NOT SUFFICIENT, because
  // neither `static`/`build` nor `unit` is a leaf verdict:
  //   * every gated job opens with a "Require successful admission" step that
  //     exits 1 whenever `needs.admission.result != 'success'`, and
  //   * `unit` is a fan-in whose check is `[ "$SHARD_RESULT" != "success" ]`.
  // Both launder a CANCELLED upstream into a `failure` result. Observed on
  // runs 31903009051, 31900478128 and 31900226011 (2026-08-15): a cancel
  // landed during `admission`'s 120s sleep and Static, Unit AND Build all
  // reported `failure` on a run that tested nothing. `always()` would have
  // filed an issue for each. `!cancelled()` still runs when a need FAILED,
  // but never when the run was cancelled.
  for (const [id, condition] of [
    [NOTIFIER, notifier().if],
    [RECOVERY, recovery().if],
  ]) {
    assert.match(condition, /!cancelled\(\)/, `${id} must be guarded against cancelled runs.`);
    assert.doesNotMatch(
      condition,
      /always\(\)/,
      `${id} must not use always(): it fires during cancellation, and the admission gate and the Unit fan-in both report 'failure' for a cancelled run.`
    );
  }

  // The laundering this guard compensates for must still be real. If the
  // aggregator is ever tightened to propagate cancellation honestly, this
  // assertion fails and the reasoning above gets revisited rather than
  // silently rotting.
  const unitCheck = (workflowJob('unit').steps ?? []).map((step) => step.run ?? '').join('\n');
  assert.match(
    unitCheck,
    /!=\s*"success"/,
    'the Unit fan-in still converts any non-success shard result into a failure; the notifier guard above depends on that being compensated, not assumed away.'
  );
});

test('green main closes the tracking issue, so de-duplication tracks one incident', () => {
  // Label-keyed de-duplication was copied from the nightly notifiers, but the
  // lifecycles differ: a nightly failure recurs on a 24h cadence, whereas a
  // red `main` is usually fixed within the hour while the issue stays open
  // until a human closes it. Without this job, incident #2 weeks later would
  // append a comment to incident #1's stale, mistitled issue and never surface
  // in triage — the canary muted.
  const job = recovery();

  assert.deepEqual(
    [...job.needs].sort(),
    [...WATCHED_JOBS].sort(),
    'recovery must observe the same verdicts the notifier does, or the two disagree about what "green" means.'
  );
  assert.match(job.if, /github\.event_name == 'push'/);
  for (const jobId of WATCHED_JOBS) {
    assert.match(
      job.if,
      new RegExp(`needs\\.${jobId}\\.result == 'success'`),
      `main is only green once ${jobId} passes; a partial green must not close the issue.`
    );
  }
  assert.equal(job.permissions?.issues, 'write', 'recovery must be able to close the issue.');

  const script = (job.steps ?? []).map((step) => step.run).join('\n');
  assert.match(script, /gh issue close/, 'recovery must actually close the issue.');
  assert.match(
    script,
    /--label "main-broken"/,
    'recovery must key on the same label the notifier writes.'
  );
});

test('the notifier can file an issue, stays cheap, and never touches the paid pool', () => {
  for (const [id, job] of [
    [NOTIFIER, notifier()],
    [RECOVERY, recovery()],
  ]) {
    assert.equal(job.permissions?.contents, 'read', `${id} needs no write access to the repo.`);
    assert.ok(
      typeof job['timeout-minutes'] === 'number' && job['timeout-minutes'] <= 10,
      `${id}: a hung gh API call must not burn the six-hour GitHub Actions default.`
    );
    assert.doesNotMatch(
      String(job['runs-on']),
      /^ubicloud/,
      `${id}: five-second main notifiers must remain on GitHub-hosted runners.`
    );
    const steps = job.steps ?? [];
    assert.ok(steps.length > 0, `${id} must actually do something.`);
    for (const step of steps) {
      assert.ok(typeof step.run === 'string', `${id}: notifier steps are plain gh invocations.`);
    }
  }
  assert.equal(
    notifier().permissions?.issues,
    'write',
    'the notifier must be able to open an issue.'
  );

  // The workflow-level default is read-only, so the elevation above must be
  // job-scoped — the same shape the four existing notify-failure jobs use.
  const workflow = parseYaml(workflowSource());
  assert.equal(workflow.permissions?.issues, undefined);

  const script = (notifier().steps ?? []).map((step) => step.run).join('\n');
  assert.match(script, /gh issue create/, 'a first failure must open a tracking issue.');
  assert.match(script, /gh issue comment/, 'a repeat failure must comment, not open a duplicate.');
  assert.match(script, /--label "main-broken"/, 'the de-duplication key must stay stable.');
});

test('nothing silently disarms the notifier', () => {
  // The sibling notifiers write `gh label create ... 2>/dev/null || true`,
  // which absorbs the expected "label already exists" AND a genuine failure
  // (token not elevated, API 5xx, org label restrictions) indistinguishably.
  // The label does not exist until the first red `main`, so a swallowed
  // failure on that very first run makes the next step's `gh issue create
  // --label` hard-fail and NOTHING gets filed — the "red run sits unseen"
  // outcome one level up. `--force` makes "already exists" a success instead
  // of an error, so there is nothing left to suppress.
  const steps = notifier().steps ?? [];
  const labelStep = steps.find((step) => /gh label create/.test(step.run ?? ''));
  assert.ok(labelStep, 'the notifier must ensure its de-duplication label exists.');
  const command = executableLines(labelStep.run);

  assert.match(
    command,
    /--force/,
    'use --force so an existing label is a success, not an error to swallow.'
  );
  assert.doesNotMatch(
    command,
    /\|\|\s*true/,
    '`|| true` would swallow a real failure and leave the notifier unable to file anything.'
  );
  assert.doesNotMatch(
    command,
    /2>\/dev\/null/,
    'discarding stderr here hides exactly the diagnosis needed when the notifier cannot file.'
  );
  assert.match(command, /set -euo pipefail/, 'a failing gh call must fail the step.');
});

test('CONTROL: dropping a watched job from the notifier FAILS this contract', () => {
  const source = workflowSource();
  // `needs: [static, unit, build]` now appears on both notifier and recovery;
  // String.replace hits the first, which is the notifier's.
  const mutated = source.replace('needs: [static, unit, build]', 'needs: [unit, build]');
  assert.notEqual(
    mutated,
    source,
    'the control mutation matched nothing in test.yml — the control would be vacuous.'
  );
  assert.deepEqual(
    [...recovery(mutated).needs].sort(),
    [...WATCHED_JOBS].sort(),
    'the control must have mutated the notifier, not the recovery job.'
  );

  assert.throws(
    () => {
      assert.deepEqual([...notifier(mutated).needs].sort(), [...WATCHED_JOBS].sort());
    },
    /Expected values to be strictly deep-equal/,
    'a notifier that stopped watching Static must FAIL this contract.'
  );
});

test('CONTROL: reverting the cancellation guard to always() FAILS this contract', () => {
  const source = workflowSource();
  const mutated = source.replace('!cancelled() &&', 'always() &&');
  assert.notEqual(
    mutated,
    source,
    'the control mutation matched nothing in test.yml — the control would be vacuous.'
  );

  assert.throws(
    () => {
      assert.doesNotMatch(notifier(mutated).if, /always\(\)/);
    },
    /The input was expected to not match the regular expression/,
    'a notifier that fires on cancelled runs must FAIL this contract.'
  );
});

test('CONTROL: restoring the blanket `|| true` suppression FAILS this contract', () => {
  const source = workflowSource();
  const mutated = source.replace(
    'fails Static, Unit or Build"; then',
    'fails Static, Unit or Build" 2>/dev/null || true; then'
  );
  assert.notEqual(
    mutated,
    source,
    'the control mutation matched nothing in test.yml — the control would be vacuous.'
  );

  assert.throws(
    () => {
      const labelStep = (notifier(mutated).steps ?? []).find((step) =>
        /gh label create/.test(step.run ?? '')
      );
      assert.doesNotMatch(executableLines(labelStep.run), /\|\|\s*true/);
    },
    /The input was expected to not match the regular expression/,
    'a notifier whose label step swallows failures must FAIL this contract.'
  );
});

test('CONTROL: deleting the recovery job FAILS this contract', () => {
  const source = workflowSource();
  const mutated = source.replace(`  ${RECOVERY}:\n`, '  notify-main-recovery-disabled:\n');
  assert.notEqual(
    mutated,
    source,
    'the control mutation matched nothing in test.yml — the control would be vacuous.'
  );

  assert.throws(
    () => recovery(mutated),
    /must define the "notify-main-recovery" job/,
    'losing the auto-close turns label de-duplication back into a stale-issue trap and must FAIL this contract.'
  );
});
