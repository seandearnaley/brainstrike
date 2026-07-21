import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  configuredHookDisables,
  deriveCharter,
  git,
  parseReport,
  partitionReports,
} from './collect-magnify-evidence.mjs';

test('derives mutable values from the live charter text', () => {
  const charter = deriveCharter(`
NAME=Magnify
CHARTER_VERSION=7
STATE_ISSUE="[automation-state] Magnify"
WALL_CLOCK_BUDGET=60 minutes
Objective: review/risk-3-elevated and review/risk-4-high
Max 2 PRs per run, risk-4 first,
then oldest.
<!-- magnify:v7 <pr>:<head-sha> -->
`);

  assert.deepEqual(charter, {
    markerTemplate: '<!-- magnify:v7 <pr>:<head-sha> -->',
    maximumPullRequests: 2,
    name: 'Magnify',
    risk3Label: 'review/risk-3-elevated',
    risk4Label: 'review/risk-4-high',
    stateIssue: '[automation-state] Magnify',
    version: '7',
    wallClockBudget: '60 minutes',
  });
});

test('derives mutable values from the real repository charter', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const charter = deriveCharter(
    readFileSync(join(repoRoot, '.night-shift/charters/magnify.md'), 'utf8')
  );
  assert.match(charter.version, /^\d+$/);
  assert.equal(charter.stateIssue, '[automation-state] Magnify');
  assert.ok(charter.maximumPullRequests >= 1);
});

test('rejects a non-integer CHARTER_VERSION that could not round-trip through markers', () => {
  assert.throws(
    () =>
      deriveCharter(`
NAME=Magnify
CHARTER_VERSION=2.0
STATE_ISSUE="[automation-state] Magnify"
WALL_CLOCK_BUDGET=60 minutes
review/risk-3-elevated review/risk-4-high
Max 2 PRs per run, risk-4 first, then oldest.
<!-- magnify:v2.0 <pr>:<head-sha> -->
`),
    /CHARTER_VERSION must be an integer/
  );
});

test('a quoted or inline marker never parses as a report', () => {
  const sha = 'a'.repeat(40);
  assert.equal(
    parseReport({ body: `> <!-- magnify:v1 12:${sha} -->\nlooks wrong to me` }),
    null,
    'blockquoted marker must not parse'
  );
  assert.equal(
    parseReport({ body: `the marker <!-- magnify:v1 12:${sha} --> appears mid-sentence` }),
    null,
    'mid-line marker must not parse'
  );
  assert.notEqual(
    parseReport({ body: `<!-- magnify:v1 12:${sha} -->\nFindings below.` }),
    null,
    'line-start marker must parse'
  );
});

test('keeps copied markers for another PR out of report history', () => {
  const own = {
    body: `<!-- magnify:v1 12:${'a'.repeat(40)} -->`,
    createdAt: '2026-07-21T00:00:00Z',
  };
  const foreign = {
    body: `<!-- magnify:v1 99:${'b'.repeat(40)} -->`,
    createdAt: '2026-07-21T01:00:00Z',
  };

  const partitioned = partitionReports([own, foreign], 12);

  assert.equal(partitioned.reports.length, 1);
  assert.equal(partitioned.reports[0].pullRequest, 12);
  assert.deepEqual(partitioned.foreignMarkerComments, [foreign]);
});

test('disables fsmonitor and ignores inherited Git routing variables', () => {
  const repo = mkdtempSync(join(tmpdir(), 'magnify-collector-'));
  const marker = join(repo, 'fsmonitor-ran');
  const fsmonitor = join(repo, 'fsmonitor.sh');
  const previousGitDir = process.env.GIT_DIR;

  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(fsmonitor, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, 'utf8');
    chmodSync(fsmonitor, 0o755);
    execFileSync('git', ['config', 'core.fsmonitor', fsmonitor], { cwd: repo });
    execFileSync('git', ['config', 'hook.sentinel.command', fsmonitor], { cwd: repo });
    process.env.GIT_DIR = join(repo, 'does-not-exist');

    assert.deepEqual(configuredHookDisables(repo), ['-c', 'hook.sentinel.enabled=false']);
    assert.equal(git(repo, ['status', '--short']), '?? fsmonitor.sh\n');
    assert.equal(existsSync(marker), false);
  } finally {
    if (previousGitDir === undefined) {
      delete process.env.GIT_DIR;
    } else {
      process.env.GIT_DIR = previousGitDir;
    }
    rmSync(repo, { force: true, recursive: true });
  }
});
