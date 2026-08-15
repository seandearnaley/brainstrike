import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectChildProcessOutput,
  findUnlinkedPullRequests,
  formatConformanceReport,
  GITHUB_OPEN_PULL_REQUEST_ARGS,
  listOpenPullRequests,
  normalizeOpenPullRequestPages,
  parseGitHubCliResult,
} from '../check-open-pr-linear-conformance.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const pullRequest = (overrides = {}) => ({
  author: { login: 'seandearnaley' },
  body: '## Summary\n\nRefs BST-521',
  number: 42,
  title: 'ci: add a conformance check',
  url: 'https://github.com/seandearnaley/brainstrike/pull/42',
  ...overrides,
});

test('finds open PRs whose descriptions omit a BST issue reference', () => {
  const findings = findUnlinkedPullRequests([
    pullRequest(),
    pullRequest({ body: 'No tracker is linked.', number: 43, title: 'Untracked work' }),
    pullRequest({ body: null, number: 44, title: 'Empty description' }),
  ]);

  assert.deepEqual(
    findings.map(({ number, title }) => ({ number, title })),
    [
      { number: 43, title: 'Untracked work' },
      { number: 44, title: 'Empty description' },
    ]
  );
});

test('checks descriptions specifically instead of accepting a title-only reference', () => {
  const findings = findUnlinkedPullRequests([
    pullRequest({ body: 'No issue link here.', title: 'ci(BST-521): title-only reference' }),
  ]);

  assert.equal(findings.length, 1);
});

test('excludes dependency bots while retaining human maintenance PRs', () => {
  const findings = findUnlinkedPullRequests([
    pullRequest({ author: { login: 'dependabot[bot]' }, body: '', number: 45 }),
    pullRequest({ author: { login: 'renovate[bot]' }, body: '', number: 46 }),
    pullRequest({ body: 'Routine human maintenance.', number: 47, title: 'Maintenance' }),
  ]);

  assert.deepEqual(
    findings.map(({ number }) => number),
    [47]
  );
});

test('report includes PR number, title, URL, and a concrete suggested action', () => {
  const report = formatConformanceReport([
    pullRequest({
      body: '',
      number: 48,
      title: 'Missing tracker',
      url: 'https://github.com/seandearnaley/brainstrike/pull/48',
    }),
  ]);

  assert.match(report, /#48 Missing tracker/);
  assert.match(report, /https:\/\/github\.com\/seandearnaley\/brainstrike\/pull\/48/);
  assert.match(report, /Suggested action: add `BST-###`/);
  assert.match(report, /warning only; no PRs were modified/i);
});

test('normalizes every page returned by the exhaustive GitHub REST pagination', () => {
  const normalized = normalizeOpenPullRequestPages([
    [
      {
        body: 'Refs BST-1',
        html_url: 'https://github.com/example/repo/pull/1',
        number: 1,
        title: 'First',
        user: { login: 'first-author' },
      },
    ],
    [
      {
        body: null,
        html_url: 'https://github.com/example/repo/pull/201',
        number: 201,
        title: 'Beyond the first page',
        user: { login: 'second-author' },
      },
    ],
  ]);

  assert.deepEqual(
    normalized.map(({ author, number, url }) => ({ author: author.login, number, url })),
    [
      { author: 'first-author', number: 1, url: 'https://github.com/example/repo/pull/1' },
      {
        author: 'second-author',
        number: 201,
        url: 'https://github.com/example/repo/pull/201',
      },
    ]
  );
});

test('GitHub invocation exhausts pagination instead of imposing a silent item limit', () => {
  assert.ok(GITHUB_OPEN_PULL_REQUEST_ARGS.includes('--paginate'));
  assert.ok(GITHUB_OPEN_PULL_REQUEST_ARGS.includes('--slurp'));
  assert.equal(GITHUB_OPEN_PULL_REQUEST_ARGS.includes('--limit'), false);
});

test('streamed GitHub output is not capped at spawnSync default buffer size', async () => {
  const outputBytes = 2 * 1024 * 1024;
  const child = spawn(process.execPath, ['-e', `process.stdout.write('x'.repeat(${outputBytes}))`]);

  const result = await collectChildProcessOutput(child);

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.length, outputBytes);
});

test('streamed process collection rejects children without piped output', () => {
  assert.throws(
    () => collectChildProcessOutput({}),
    /Expected a child process with piped stdout and stderr/
  );
});

test('GitHub CLI failures distinguish non-zero exits from terminating signals', () => {
  assert.throws(
    () => parseGitHubCliResult({ signal: null, status: 3, stderr: 'boom', stdout: '' }),
    /GitHub CLI failed with exit 3: boom/
  );
  assert.throws(
    () => parseGitHubCliResult({ signal: 'SIGTERM', status: null, stderr: '', stdout: '' }),
    /GitHub CLI failed with signal SIGTERM:/
  );
});

test('signal termination survives the real child close-event seam', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)']);
  child.kill('SIGTERM');

  const result = await collectChildProcessOutput(child);

  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.throws(() => parseGitHubCliResult(result), /GitHub CLI failed with signal SIGTERM:/);
});

test('missing GitHub CLI failures retain the spawn error context', async () => {
  await assert.rejects(
    () => listOpenPullRequests(() => spawn('brainstrike-gh-command-that-does-not-exist')),
    /Unable to run GitHub CLI: spawn brainstrike-gh-command-that-does-not-exist ENOENT/
  );
});

test('malformed JSON and malformed pagination shapes remain distinct failures', () => {
  assert.throws(
    () => parseGitHubCliResult({ signal: null, status: 0, stderr: '', stdout: '{' }),
    /GitHub CLI returned malformed JSON/
  );
  assert.throws(
    () => parseGitHubCliResult({ signal: null, status: 0, stderr: '', stdout: '{}' }),
    /Expected GitHub pagination to return an array of pages/
  );
});

test('validation rejects malformed pages and malformed pull requests', () => {
  assert.throws(
    () => normalizeOpenPullRequestPages([{}]),
    /GitHub returned a non-array PR page at index 0/
  );
  assert.throws(
    () => normalizeOpenPullRequestPages([[null]]),
    /GitHub returned a non-object PR on page 0/
  );
  assert.throws(
    () => findUnlinkedPullRequests([pullRequest({ author: {}, number: 49 })]),
    /GitHub returned no author login for PR #49/
  );
  assert.throws(
    () => findUnlinkedPullRequests([pullRequest({ body: 42, number: 50 })]),
    /GitHub returned an invalid body for PR #50/
  );
});

test('raw REST pages preserve bot exclusions and actionable human URLs end to end', () => {
  const pullRequests = normalizeOpenPullRequestPages([
    [
      {
        body: '',
        html_url: 'https://github.com/example/repo/pull/51',
        number: 51,
        title: 'Dependency update',
        user: { login: 'dependabot[bot]' },
      },
      {
        body: 'No issue reference.',
        html_url: 'https://github.com/example/repo/pull/52',
        number: 52,
        title: 'Human maintenance',
        user: { login: 'maintainer' },
      },
    ],
  ]);

  const findings = findUnlinkedPullRequests(pullRequests);

  assert.deepEqual(
    findings.map(({ number, url }) => ({ number, url })),
    [{ number: 52, url: 'https://github.com/example/repo/pull/52' }]
  );
});

test('clean report states that every inspected PR is linked', () => {
  assert.match(
    formatConformanceReport([]),
    /All inspected open PR descriptions reference `BST-###`/
  );
});

test('pull request template prompts authors for the required Linear reference', () => {
  const template = readFileSync(resolve(repoRoot, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8');
  assert.match(template, /^Ticket: BST-###$/m);
});
