import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareReview, reportReview } from '../claude-review.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const trusted = 'c'.repeat(40);

function fixture(
  t,
  {
    eventName = 'pull_request',
    files = [],
    actionConclusion = 'success',
    headRepo = 'owner/repo',
    baseRef = 'main',
    baseRepo = 'owner/repo',
    diffBytes = 0,
  } = {}
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-review-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const pr = {
    base: { ref: baseRef, repo: { full_name: baseRepo }, sha: base },
    changed_files: files.length,
    head: { repo: headRepo === null ? null : { full_name: headRepo }, sha: head },
    number: 42,
    state: 'open',
  };
  const event = {
    inputs: { expected_head: head, focus: 'Verify the workflow trust boundary', pr_number: '42' },
    pull_request: pr,
    repository: { default_branch: 'main' },
  };
  const env = {
    ACTION_CONCLUSION: actionConclusion,
    ACTION_OUTCOME: 'success',
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: path.join(dir, 'event.json'),
    GITHUB_OUTPUT: path.join(dir, 'output'),
    GITHUB_REF: eventName === 'workflow_dispatch' ? 'refs/heads/main' : 'refs/pull/42/merge',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '123',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_SHA: trusted,
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    GITHUB_WORKFLOW_REF: `owner/repo/.github/workflows/claude-code-review.yml@${eventName === 'workflow_dispatch' ? 'refs/heads/main' : 'refs/pull/42/merge'}`,
    REVIEW_OUTPUT: JSON.stringify({
      base_sha: base,
      completed: true,
      head_sha: head,
      review: 'The requested scope was reviewed; no findings.',
      scope: eventName === 'workflow_dispatch' ? 'targeted' : 'whole PR',
    }),
    RUNNER_TEMP: dir,
  };
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'diff') {
      const small = 'diff --git a/test.txt b/test.txt\n+sample\n';
      return diffBytes > 0 ? `${small}+${'x'.repeat(diffBytes)}\n` : small;
    }
    if (args[0] === 'pr' && args[1] === 'comment') {
      return 'https://github.com/owner/repo/pull/42#issuecomment-99';
    }
    if (args[1] === 'repos/owner/repo/pulls/42') {
      return JSON.stringify(pr);
    }
    if (args[1] === 'repos/owner/repo/pulls/42/files') {
      return JSON.stringify([files.map((filename) => ({ filename }))]);
    }
    throw new Error(`Unexpected gh request: ${JSON.stringify(args)}`);
  };
  return {
    calls,
    env,
    event,
    gh,
    gitHead: () => trusted,
    noReview: () => {
      env.REVIEW_OUTPUT = '';
    },
    pr,
    summary: () => readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'),
    updateEvent: () => writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event)),
  };
}

test('normal completion requires explicit action conclusion and valid exact-head review output', (t) => {
  const f = fixture(t);
  assert.equal(prepareReview(f), 0);
  assert.equal(reportReview(f), 0);
  assert.match(f.summary(), /Claude review completed/);
  assert.match(f.summary(), new RegExp(head));
  assert.match(f.summary(), /issuecomment-99/);
  assert.equal(f.calls.filter((call) => call[0] === 'pr' && call[1] === 'diff').length, 1);
});

test('self-change skips Claude visibly and supplies trusted targeted invocation', (t) => {
  const f = fixture(t, { files: ['.github/workflows/claude-code-review.yml'] });
  assert.equal(prepareReview(f), 0);
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), /eligible<<[^\n]+\nfalse\n/);
  assert.equal(reportReview(f), 1);
  assert.match(f.summary(), /Claude review skipped/);
  assert.match(f.summary(), /--ref main/);
  assert.match(f.summary(), new RegExp(`expected_head=${head}`));
  // A self-change skip keeps the trust-boundary focus, which is what it lost.
  assert.match(f.summary(), /focus=Review the workflow trust boundary/);
  assert.ok(f.calls.some((call) => call[0] === 'pr' && call[1] === 'comment'));
});

test('a stacked layer based on another branch of this repository is reviewed against that base', (t) => {
  const f = fixture(t, { baseRef: 'feat/parent-layer' });
  assert.equal(prepareReview(f), 0);
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), /eligible<<[^\n]+\ntrue\n/);
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), new RegExp(`BASE: ${base}`));
  assert.equal(reportReview(f), 0);
  assert.match(f.summary(), /Claude review completed/);
});

test('a maintainer can dispatch a targeted review of a stacked layer', (t) => {
  const f = fixture(t, { baseRef: 'feat/parent-layer', eventName: 'workflow_dispatch' });
  assert.equal(prepareReview(f), 0);
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), /eligible<<[^\n]+\ntrue\n/);
});

test('pull_request_target and other events fail closed', (t) => {
  const f = fixture(t, { eventName: 'pull_request_target' });
  assert.equal(prepareReview(f), 1);
  assert.doesNotMatch(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), /eligible<<[^\n]+\ntrue\n/);
});

test('a pull_request run must execute its own merge ref, not some other ref', (t) => {
  const f = fixture(t);
  f.env.GITHUB_REF = 'refs/heads/main';
  assert.equal(prepareReview(f), 1);
  assert.equal(reportReview(f), 1);
  assert.match(f.summary(), /own event ref/);
});

test('an oversized diff is refused visibly with its size instead of crashing the action', (t) => {
  const f = fixture(t, { diffBytes: 120 * 1024 });
  assert.equal(prepareReview(f), 0);
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), /eligible<<[^\n]+\nfalse\n/);
  assert.equal(reportReview(f), 1);
  assert.match(f.summary(), /Claude auto-review did not complete/);
  assert.match(f.summary(), /too large/);
  assert.match(f.summary(), /KiB/);
  assert.match(f.summary(), /split/i);
  assert.doesNotMatch(f.summary(), /gh workflow run/);
});

test('an automatic fork-head PR is refused instead of silently reviewed', (t) => {
  const f = fixture(t, { headRepo: 'attacker/repo' });
  assert.equal(prepareReview(f), 0);
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), /eligible<<[^\n]+\nfalse\n/);
  assert.equal(f.calls.filter((call) => call[0] === 'pr' && call[1] === 'diff').length, 0);
  assert.equal(reportReview(f), 1);
  assert.match(f.summary(), /Claude review skipped/);
  assert.match(f.summary(), /outside the trusted repository/);
  // The recovery command must request the review this PR actually lost, not the
  // workflow-trust-boundary focus that only fits a self-change skip.
  assert.match(f.summary(), /gh workflow run claude-code-review.yml/);
  assert.match(f.summary(), /focus=Review the complete diff/);
  assert.doesNotMatch(f.summary(), /workflow trust boundary/);
});

test('a deleted fork head repository cannot pass the trusted-head guard', (t) => {
  const f = fixture(t, { headRepo: null });
  assert.equal(prepareReview(f), 0);
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), /eligible<<[^\n]+\nfalse\n/);
  assert.equal(reportReview(f), 1);
  assert.match(f.summary(), /outside the trusted repository/);
});

test('a maintainer can still dispatch a targeted review of a fork-head PR', (t) => {
  const f = fixture(t, { eventName: 'workflow_dispatch', headRepo: 'attacker/repo' });
  assert.equal(prepareReview(f), 0);
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), /eligible<<[^\n]+\ntrue\n/);
  assert.equal(reportReview(f), 0);
  assert.match(f.summary(), /Claude review completed/);
});

test('targeted trusted dispatch can review workflow self-change without PR code checkout', (t) => {
  const f = fixture(t, {
    eventName: 'workflow_dispatch',
    files: ['.github/workflows/claude-code-review.yml'],
  });
  assert.equal(prepareReview(f), 0);
  const outputs = readFileSync(f.env.GITHUB_OUTPUT, 'utf8');
  assert.match(outputs, /eligible<<[^\n]+\ntrue\n/);
  assert.match(outputs, /Verify the workflow trust boundary/);
  assert.match(outputs, /captured diff/);
  assert.equal(reportReview(f), 0);
  assert.match(f.summary(), /Scope: targeted/);
});

for (const [name, outcome, conclusion] of [
  ['action failure or turn cap', 'failure', 'failure'],
  ['OIDC skip reported by upstream as successful action', 'success', ''],
  ['cancelled action', 'cancelled', ''],
]) {
  test(`${name} stays incomplete and red with a PR disposition`, (t) => {
    const f = fixture(t, { actionConclusion: conclusion });
    prepareReview(f);
    f.env.ACTION_OUTCOME = outcome;
    assert.equal(reportReview(f), 1);
    assert.match(f.summary(), /Claude auto-review did not complete/);
    assert.doesNotMatch(f.summary(), /Claude review completed/);
    assert.ok(f.calls.some((call) => call[0] === 'pr' && call[1] === 'comment'));
  });
}

test('green action without review content is incomplete', (t) => {
  const f = fixture(t);
  prepareReview(f);
  f.noReview();
  assert.equal(reportReview(f), 1);
  assert.match(f.summary(), /Claude auto-review did not complete/);
});

test('moving head invalidates completion instead of claiming current coverage', (t) => {
  const f = fixture(t);
  prepareReview(f);
  f.pr.head.sha = 'd'.repeat(40);
  assert.equal(reportReview(f), 1);
  assert.match(f.summary(), /head or base changed/);
  assert.match(f.summary(), new RegExp(head));
});

test('moving head while capturing diff is rejected before Claude runs', (t) => {
  const f = fixture(t);
  const originalGh = f.gh;
  f.gh = (args) => {
    const response = originalGh(args);
    if (args[0] === 'pr' && args[1] === 'diff') {
      f.pr.head.sha = 'd'.repeat(40);
    }
    return response;
  };
  assert.equal(prepareReview(f), 1);
  assert.equal(reportReview(f), 1);
  assert.match(f.summary(), /head or base changed/);
});

for (const kind of [
  'stale head',
  'untrusted ref',
  'malformed base payload',
  'checkout mismatch',
  'missing focus',
]) {
  test(`${kind} fails closed before invoking Claude`, (t) => {
    const f = fixture(t, { eventName: 'workflow_dispatch' });
    if (kind === 'stale head') {
      f.event.inputs.expected_head = 'e'.repeat(40);
    }
    if (kind === 'untrusted ref') {
      f.env.GITHUB_REF = 'refs/heads/attacker';
    }
    if (kind === 'malformed base payload') {
      f.pr.base.repo = { full_name: 'attacker/repo' };
    }
    if (kind === 'checkout mismatch') {
      f.gitHead = () => 'e'.repeat(40);
    }
    if (kind === 'missing focus') {
      f.event.inputs.focus = '';
    }
    f.updateEvent();
    assert.equal(prepareReview(f), 1);
    assert.equal(reportReview(f), 1);
    assert.doesNotMatch(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), /eligible<<[^\n]+\ntrue\n/);
  });
}

test('GitHub API failure cannot turn into eligibility or completed review', (t) => {
  const f = fixture(t);
  const gh = f.gh;
  f.gh = (args) => {
    if (args[1].endsWith('/files')) {
      throw new Error('GitHub API unavailable');
    }
    return gh(args);
  };
  assert.equal(prepareReview(f), 1);
  assert.equal(reportReview(f), 1);
  assert.match(f.summary(), /GitHub API unavailable/);
});

test('truncated changed-file inventory cannot hide an orchestration change', (t) => {
  const f = fixture(t);
  f.pr.changed_files = 3001;
  assert.equal(prepareReview(f), 1);
  assert.equal(reportReview(f), 1);
  assert.match(f.summary(), /changed-file inventory is incomplete/);
});

test('review has no model execution or file tools and returns structured output', (t) => {
  const f = fixture(t, { eventName: 'workflow_dispatch' });
  prepareReview(f);
  const outputs = readFileSync(f.env.GITHUB_OUTPUT, 'utf8');
  assert.doesNotMatch(outputs, /mcp__github_inline_comment__/);
  assert.match(outputs, /--tools=/);
  assert.match(outputs, /--disallowedTools" "mcp__\*"/);
  assert.match(outputs, /--strict-mcp-config/);
  assert.match(outputs, /--json-schema/);
  assert.match(outputs, /CAPTURED DIFF/);
  assert.match(outputs, /diff --git/);
});

for (const invalid of [
  { completed: false },
  { head_sha: 'd'.repeat(40) },
  { base_sha: 'd'.repeat(40) },
  { scope: 'targeted' },
  { review: '' },
  { tool_calls: [{ name: 'Bash' }] },
]) {
  test(`invalid model output is rejected before any completed review is published: ${JSON.stringify(invalid)}`, (t) => {
    const f = fixture(t);
    prepareReview(f);
    f.env.REVIEW_OUTPUT = JSON.stringify({ ...JSON.parse(f.env.REVIEW_OUTPUT), ...invalid });
    assert.equal(reportReview(f), 1);
    assert.match(f.summary(), /did not return a complete structured review/);
    assert.ok(
      f.calls
        .filter((call) => call[0] === 'pr' && call[1] === 'comment')
        .every((call) => !call.at(-1).includes('## Claude review completed'))
    );
  });
}

test('publication failure cannot become completed coverage and does not blindly retry', (t) => {
  const f = fixture(t);
  prepareReview(f);
  const originalGh = f.gh;
  let publications = 0;
  f.gh = (args) => {
    if (args[0] === 'pr' && args[1] === 'comment') {
      publications++;
      throw new Error('GitHub unavailable');
    }
    return originalGh(args);
  };
  assert.equal(reportReview(f), 1);
  assert.equal(publications, 1);
  assert.match(f.summary(), /Publication failed/);
  assert.doesNotMatch(f.summary(), /## Claude review completed/);
});

test('optional CLI probe is import-safe and does not require Claude in default tests', async () => {
  const probe = await import('../probe-claude-review-tools.mjs');
  assert.equal(typeof probe.main, 'function');
});
