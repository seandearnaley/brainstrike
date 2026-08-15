import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findUnlinkedPullRequests,
  formatConformanceReport,
} from '../check-open-pr-linear-conformance.mjs';

const pullRequest = (overrides = {}) => ({
  author: { login: 'seandearnaley' },
  body: '## Summary\n\nRefs BST-521',
  isDraft: false,
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
    pullRequest({ body: '', number: 48, title: 'Missing tracker' }),
  ]);

  assert.match(report, /#48 Missing tracker/);
  assert.match(report, /https:\/\/github\.com\/seandearnaley\/brainstrike\/pull\/42/);
  assert.match(report, /Suggested action: add `BST-###`/);
  assert.match(report, /warning only; no PRs were modified/i);
});

test('clean report states that every inspected PR is linked', () => {
  assert.match(
    formatConformanceReport([]),
    /All inspected open PR descriptions reference `BST-###`/
  );
});
