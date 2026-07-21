import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  configuredHookDisables,
  deriveCharter,
  git,
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
