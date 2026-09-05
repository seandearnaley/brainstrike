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
  { eventName = 'pull_request_target', files = [], actionConclusion = 'success' } = {}
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-review-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const pr = {
    base: { ref: 'main', sha: base },
    changed_files: files.length,
    head: { sha: head },
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
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '123',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_SHA: trusted,
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/claude-code-review.yml@refs/heads/main',
    RUNNER_TEMP: dir,
  };
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
  const calls = [];
  let postedReview = true;
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'diff') {
      return 'diff --git a/test.txt b/test.txt\n+sample\n';
    }
    if (args[0] === 'pr' && args[1] === 'comment') {
      return '';
    }
    if (args[1] === 'repos/owner/repo/pulls/42') {
      return JSON.stringify(pr);
    }
    if (args[1] === 'repos/owner/repo/pulls/42/files') {
      return JSON.stringify([files.map((filename) => ({ filename }))]);
    }
    if (args[1] === 'repos/owner/repo/issues/42/comments') {
      return JSON.stringify([
        postedReview
          ? [
              {
                body: `<!-- claude-review:123:1:${head} -->\nReview findings: sample.`,
                html_url: 'https://github.com/owner/repo/pull/42#issuecomment-99',
                user: { login: 'claude[bot]' },
              },
            ]
          : [],
      ]);
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
      postedReview = false;
    },
    pr,
    summary: () => readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'),
    updateEvent: () => writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event)),
  };
}

test('normal completion requires explicit action conclusion and posted exact-run review', (t) => {
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
  assert.ok(f.calls.some((call) => call[0] === 'pr' && call[1] === 'comment'));
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
  assert.match(f.summary(), /No exact-run Claude review comment/);
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
  'untrusted base',
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
    if (kind === 'untrusted base') {
      f.pr.base.ref = 'attacker';
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

test('targeted tools explicitly omit unavailable inline MCP and deny unapproved tools', (t) => {
  const f = fixture(t, { eventName: 'workflow_dispatch' });
  prepareReview(f);
  const outputs = readFileSync(f.env.GITHUB_OUTPUT, 'utf8');
  assert.doesNotMatch(outputs, /mcp__github_inline_comment__/);
  assert.match(outputs, /inline-comment MCP is unavailable/);
  assert.match(outputs, /--permission-mode dontAsk/);
  assert.match(outputs, /Read\(\/\//);
});
