import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  deriveCharter,
  extractAssayComments,
  isGradeCacheLabel,
} from './collect-assay-evidence.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const liveCharter = readFileSync(path.join(repoRoot, '.night-shift/charters/reviewer.md'), 'utf8');

test('deriveCharter parses the live charter, not a synthetic fixture', () => {
  const charter = deriveCharter(liveCharter);
  assert.equal(typeof charter.version, 'number');
  assert.ok(charter.riskLabels.length >= 4, 'expected the four risk grades');
  assert.ok(charter.factorLabels.includes('review/touches-schema'));
  assert.ok(charter.allowedLabels.every((label) => label.startsWith('review/')));
  assert.equal(charter.stateIssueTitle, '[automation-state] Reviewer');
});

test('deriveCharter rejects a charter whose Beat 0 allowlist cannot be isolated', () => {
  assert.throws(
    () => deriveCharter(liveCharter.replace(/^Beat 1\b/m, 'Beat one')),
    /Beat 0 label allowlist/
  );
});

function comment(body) {
  return {
    body,
    created_at: '2026-07-21T00:00:00Z',
    html_url: 'https://example.invalid',
    id: 1,
    user: { login: 'assay-bot' },
  };
}

const charter = deriveCharter(liveCharter);
const workKey = `assay:12:${'a'.repeat(40)}:${charter.version}`;
const marker = `<!-- assay:v${charter.version} ${workKey} -->`;

test('a quoted marker in a human reply never parses as a brief', () => {
  const quoted = comment(`Thanks for the grade!\n> ${marker}\n> Labels: review/risk-1-low`);
  const { assayComments, matching } = extractAssayComments([quoted], charter, workKey);
  assert.equal(assayComments.length, 0);
  assert.equal(matching.length, 0);
});

test('asserted labels come only from the Labels: line, never brief prose', () => {
  const brief = comment(
    `${marker}\nDropped review/no-tests after tests landed; review/risk-4-high floor considered.\nLabels: review/risk-2-moderate review/touches-ci`
  );
  const { matching } = extractAssayComments([brief], charter, workKey);
  assert.equal(matching.length, 1);
  assert.deepEqual(matching[0].assertedLabels, ['review/risk-2-moderate', 'review/touches-ci']);
});

test('a brief without a Labels: line asserts nothing (cache can never validate)', () => {
  const brief = comment(`${marker}\nGrade: review/risk-1-low because the diff is docs-only.`);
  const { matching } = extractAssayComments([brief], charter, workKey);
  assert.equal(matching.length, 1);
  assert.equal(matching[0].assertedLabels, null);
});

// Beat 3b's thread-state labels change when a reviewer comments, which does not
// move the head. If they entered the head-keyed grade cache, labelsMatch would
// go false on every PR the moment thread state moved — permanently disabling
// the skip path and re-grading every open PR on every 2h wake.
test('thread-state labels are excluded from the grade cache comparison', () => {
  assert.equal(isGradeCacheLabel('review/risk-1-low'), true);
  assert.equal(isGradeCacheLabel('review/touches-schema'), true);
  for (const label of [
    'review/threads-clear',
    'review/threads-open',
    'review/threads-unanswered',
  ]) {
    assert.equal(isGradeCacheLabel(label), false, `${label} must stay out of the grade cache`);
  }
  assert.equal(isGradeCacheLabel('coverage'), false, 'non-review labels are never cache inputs');
});

test('the live charter declares the thread-state labels it applies', () => {
  const charter = deriveCharter(liveCharter);
  for (const label of [
    'review/threads-clear',
    'review/threads-open',
    'review/threads-unanswered',
  ]) {
    assert.ok(charter.allowedLabels.includes(label), `Beat 0 must declare ${label}`);
  }
  assert.ok(
    charter.allowedLabels.filter((label) => !isGradeCacheLabel(label)).length === 3,
    'exactly the three thread-state labels sit outside the grade cache'
  );
});
