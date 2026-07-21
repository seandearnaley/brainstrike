import assert from 'node:assert/strict';
import test from 'node:test';

import { collectOpenPullRequests } from './collect-bolt-evidence.mjs';

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
