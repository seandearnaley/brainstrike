import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectFirstParentCommits,
  collectOpenPullRequests,
  parseCommitLog,
} from './collect-bolt-evidence.mjs';

function pullRequest(number, headRefName) {
  return {
    base: { ref: 'main' },
    draft: false,
    head: { ref: headRefName, sha: `sha-${number}` },
    html_url: `https://github.com/seandearnaley/brainstrike/pull/${number}`,
    number,
    title: `PR ${number}`,
    updated_at: '2026-07-21T00:00:00Z',
  };
}

test('discovers an open Bolt PR after the first 100 open pull requests', () => {
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    pullRequest(index + 1, `feature/${index + 1}`)
  );
  firstPage[0].draft = undefined;
  const secondPage = [pullRequest(101, 'night-shift/bolt/existing-optimization')];
  const invocations = [];
  const run = (command, args, cwd) => {
    invocations.push({ args, command, cwd });
    if (
      args[0] === 'api' &&
      args.includes('--paginate') &&
      args.includes('--slurp') &&
      args.includes('repos/seandearnaley/brainstrike/pulls?state=open&per_page=100')
    ) {
      return JSON.stringify([firstPage, secondPage]);
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  const result = collectOpenPullRequests('/fixture/repo', run);

  assert.equal(result.length, 1);
  assert.equal(result[0].number, 101);
  assert.equal(result[0].headRefName, 'night-shift/bolt/existing-optimization');
  assert.equal(invocations.length, 1);
});

test('collects commits from actual NUL-delimited git log output', (context) => {
  const repo = mkdtempSync(join(tmpdir(), 'bolt-collector-git-log-'));
  context.after(() => rmSync(repo, { force: true, recursive: true }));
  const environment = {
    ...process.env,
    GIT_AUTHOR_EMAIL: 'bolt@example.com',
    GIT_AUTHOR_NAME: 'Bolt Test',
    GIT_COMMITTER_EMAIL: 'bolt@example.com',
    GIT_COMMITTER_NAME: 'Bolt Test',
  };
  const git = (args) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  git(['init', '--quiet']);
  git(['commit', '--allow-empty', '--message', 'first collector fixture']);
  const firstSha = git(['rev-parse', 'HEAD']).trim();
  git(['commit', '--allow-empty', '--message', 'second collector fixture']);
  const secondSha = git(['rev-parse', 'HEAD']).trim();
  assert.deepEqual(
    collectFirstParentCommits(repo, 'HEAD').map(({ sha, subject }) => ({ sha, subject })),
    [
      { sha: secondSha, subject: 'second collector fixture' },
      { sha: firstSha, subject: 'first collector fixture' },
    ]
  );
  assert.throws(
    () => parseCommitLog(`${secondSha}\0date\0subject\0\n`),
    /First-parent log must be NUL-terminated/u
  );
});
