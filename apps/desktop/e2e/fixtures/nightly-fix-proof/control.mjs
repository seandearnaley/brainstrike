import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BASE = 'b59504817c1a6c6638aa181b421de01b0c49f42f';
export const REF = 'refs/heads/codex/pv67-nightly-fix-qualification-proof2';
export const PROOF_ID = 'pv67-nonempty-20261020-v2';
export const TITLE = `PROOF ${PROOF_ID}: multiply(2, 3) must equal 6`;
// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub preserves this literal title when a reusable job is skipped.
const SKIPPED_PUBLISHER_TITLE = 'Open the fix PR for ${{ inputs.issue }}';
const PREFIX = 'apps/desktop/e2e/fixtures/nightly-fix-proof/';
export const ALLOWED_PATHS = [
  '.github/workflows/nightly-fix.yml',
  ...[
    'canary.mjs',
    'canary.spec.mjs',
    'playwright.config.mjs',
    'control.mjs',
    'control.test.mjs',
  ].map((name) => PREFIX + name),
];
export const OWNERS = {
  '.claude/skills/fix-nightly/SKILL.md': '993bf7e12d500b6140157a89d1df3c23b9b330dd',
  '.github/actions/setup-workspace/action.yml': 'cb9aee1fac6aa74d8ef7d3ad292b426c4f0c6315',
  '.github/workflows/nightly-fix-agent.yml': 'f214f06ce1e384eb8bdb15f8c89ecd1265c136a6',
  '.github/workflows/nightly-linear-alert.yml': 'dc2d8bb0d5dd492ab8bfdac060d895177806aa0d',
  '.github/workflows/nightly.yml': 'e5278434c5b4cff7cb90fb9752796b62a884ff8b',
  'scripts/lib/linear-api.mjs': '0e7e8e13ee647a0d3c0f79c393f5cec8aef4eba7',
  'scripts/lib/nightly-test-results.mjs': 'fcb0538d97cec59614e6695335142e97e93bfe00',
  'scripts/nightly-fix-issue.mjs': 'ed81bc2e438a230fa27d8f36cefc53b0eabee22e',
  'scripts/nightly-fix-publication.mjs': 'b0d4393927a1171ceb2ffff2d6c5b57d3ba645e1',
  'scripts/notify-linear-nightly.mjs': 'f6eee009dcb85c4b9a9297942dd1bdb3395801ad',
};

export function guard(context) {
  assert.equal(context.repository, 'seandearnaley/brainstrike', 'canonical repository required');
  assert.equal(context.event, 'workflow_dispatch', 'manual proof only');
  assert.equal(context.ref, REF, 'exact proof ref required');
  assert.equal(context.proofId, PROOF_ID, 'fixed proof identity required');
  assert.match(context.expectedHead, /^[0-9a-f]{40}$/u, 'full expected commit required');
  assert.equal(context.sha, context.expectedHead, 'reviewed commit differs from dispatched SHA');
  assert.equal(context.checkoutHead, context.sha, 'checkout differs from dispatched SHA');
  assert.equal(context.attempt, '1', 'reruns need owner reconciliation; dispatch a separate phase');
  assert.ok(['first', 'repeat'].includes(context.phase), 'unknown receipt phase');
  assert.deepEqual([...context.changedPaths].sort(), [...ALLOWED_PATHS].sort(), 'proof-only paths');
  assert.deepEqual(context.owners, OWNERS, 'reusable owners must match reviewed main');
  assert.ok(Array.isArray(context.pullPages) && context.pullPages.every(Array.isArray));
  const pulls = context.pullPages.flat();
  assert.ok(pulls.every((pull) => Number.isSafeInteger(pull.number) && pull.number > 0));
  assert.equal(new Set(pulls.map((pull) => pull.number)).size, pulls.length);
  assert.ok(pulls.length <= 3, 'proof needs candidate plus one reserved queue slot within five');
}

export function validateReport(report, outcome, status) {
  assert.equal(outcome, 'failure', 'the real Playwright step must fail');
  assert.equal(status, 'failure', 'the canary job must stay red');
  assert.deepEqual(report.errors, [], 'setup/run errors cannot file a proof issue');
  assert.equal(report.config.workers, 1);
  assert.equal(report.config.maxFailures, 0);
  assert.equal(report.config.projects.length, 1);
  assert.equal(report.config.projects[0].retries, 0);
  assert.equal(report.stats.expected, 0);
  assert.equal(report.stats.unexpected, 1);
  assert.equal(report.stats.flaky, 0);
  assert.equal(report.stats.skipped, 0);
  const specs = [];
  function walk(suite) {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) {
      walk(child);
    }
  }
  for (const suite of report.suites) {
    walk(suite);
  }
  assert.equal(specs.length, 1, 'exactly the intended assertion must run');
  const [spec] = specs;
  assert.equal(spec.file, 'canary.spec.mjs');
  assert.equal(spec.title, TITLE);
  assert.equal(spec.tests.length, 1);
  const [test] = spec.tests;
  assert.equal(test.projectName, 'nightly-fix-proof');
  assert.equal(test.expectedStatus, 'passed');
  assert.equal(test.status, 'unexpected');
  assert.equal(test.results.length, 1, 'no retried or repeated attempt');
  const [result] = test.results;
  assert.equal(result.status, 'failed');
  assert.equal(result.errors.length, 1, 'unrelated errors stop the proof');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Playwright colors assertion messages.
  const message = result.errors[0].message.replace(/\u001b\[[0-9;]*m/gu, '');
  assert.match(message, /expect\(received\)\.toBe\(expected\)/u);
  assert.match(message, /Expected: 6/u);
  assert.match(message, /Received: 5/u);
  assert.ok(result.errors[0].location.file.endsWith('/canary.spec.mjs'));
}

export function queue(value) {
  assert.equal(value.runs_on, 'ubuntu-latest');
  assert.equal(value.issues.length, 1, 'one real notifier issue required');
  assert.match(value.issues[0], /^BST-\d+$/u);
}

export function receipt(pages, artifactPages, issue, phase, proofQueue) {
  assert.ok(['first', 'repeat'].includes(phase));
  queue(proofQueue);
  assert.deepEqual(proofQueue.issues, [issue], 'receipt must name the single queued issue');
  const jobs = pages.flatMap((page) => page.jobs);
  const artifacts = artifactPages.flatMap((page) => page.artifacts);
  const caller = `Fix the proof canary (${issue}, ${proofQueue.runs_on}) / `;
  assert.equal(
    jobs.filter((value) => value.name.startsWith('Fix the proof canary (')).length,
    2,
    'one proof caller with exactly one fix and publisher job required'
  );
  function job(name) {
    const matches = jobs.filter((value) => value.name === name);
    assert.equal(matches.length, 1, `one exact ${name} job required`);
    return matches[0];
  }
  function step(value, name, conclusion) {
    const matches = value.steps.filter((item) => item.name === name);
    assert.equal(matches.length, 1, `one ${name} step required`);
    assert.equal(matches[0].conclusion, conclusion, name);
  }
  const fix = job(`${caller}Fix ${issue}`);
  const publish = job(
    caller + (phase === 'first' ? `Open the fix PR for ${issue}` : SKIPPED_PUBLISHER_TITLE)
  );
  assert.equal(fix.status, 'completed');
  assert.equal(fix.conclusion, 'success');
  assert.equal(publish.status, 'completed');
  step(fix, 'Claim the issue', 'success');
  const patchArtifacts = artifacts.filter((value) => value.name.startsWith('nightly-fix--'));
  if (phase === 'first') {
    step(fix, 'Run the fix agent', 'success');
    step(fix, 'Hand off the commits', 'success');
    step(fix, 'Upload the fix', 'success');
    step(fix, 'Retain the patch claim before publication queues', 'success');
    assert.equal(publish.conclusion, 'success');
    step(publish, 'Publish within the repository PR budget', 'success');
    step(publish, 'Link the pull request on Linear', 'success');
    assert.equal(patchArtifacts.length, 1);
    assert.equal(patchArtifacts[0].name, `nightly-fix--${issue}`);
    assert.equal(patchArtifacts[0].expired, false);
    assert.match(patchArtifacts[0].digest, /^sha256:[0-9a-f]{64}$/u);
  } else {
    step(fix, 'Run the fix agent', 'skipped');
    step(fix, 'Hand off the commits', 'skipped');
    step(fix, 'Upload the fix', 'skipped');
    step(fix, 'Retain the patch claim before publication queues', 'skipped');
    assert.equal(publish.conclusion, 'skipped');
    assert.equal(patchArtifacts.length, 0);
  }
  return { fixJob: fix.id, issue, patchArtifacts, phase, publishJob: publish.id };
}

function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
function output(name, value) {
  assert.ok(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT required');
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  switch (process.argv[2]) {
    case 'guard':
      guard({
        attempt: env.GITHUB_RUN_ATTEMPT,
        changedPaths: git('diff', '--name-only', BASE, 'HEAD').split('\n'),
        checkoutHead: git('rev-parse', 'HEAD'),
        event: env.GITHUB_EVENT_NAME,
        expectedHead: env.EXPECTED_HEAD,
        owners: Object.fromEntries(
          Object.keys(OWNERS).map((name) => [name, git('rev-parse', `HEAD:${name}`)])
        ),
        phase: env.PROOF_PHASE,
        proofId: env.PROOF_ID,
        pullPages: json(env.PULL_PAGES),
        ref: env.GITHUB_REF,
        repository: env.GITHUB_REPOSITORY,
        sha: env.GITHUB_SHA,
      });
      break;
    case 'report':
      validateReport(json(env.REPORT_FILE), env.CANARY_OUTCOME, env.JOB_STATUS);
      output('validated', 'true');
      break;
    case 'queue':
      queue(json(env.QUEUE_FILE));
      break;
    case 'receipt': {
      const value = receipt(
        json(env.JOBS_FILE),
        json(env.ARTIFACTS_FILE),
        env.PROOF_ISSUE,
        env.PROOF_PHASE,
        json(env.QUEUE_FILE)
      );
      writeFileSync(
        env.RECEIPT_FILE,
        `${JSON.stringify(
          {
            ...value,
            headSha: env.GITHUB_SHA,
            proofId: PROOF_ID,
            queueSha256: createHash('sha256').update(readFileSync(env.QUEUE_FILE)).digest('hex'),
            runId: env.GITHUB_RUN_ID,
          },
          null,
          2
        )}\n`
      );
      break;
    }
    default:
      throw new Error('Expected guard, report, queue or receipt.');
  }
}
