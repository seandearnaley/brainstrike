import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildMcpVerificationInvocation,
  interpretChildResult,
  main,
  normalizeForwardedArgs,
  resolveGitEvidence,
} from '../run-mcp-verification.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';

test('forwards only runner-owned profile and output arguments', () => {
  assert.deepEqual(
    normalizeForwardedArgs(['--', '--profile', 'pr', '--output', 'artifacts/pr-evidence.json']),
    ['--profile', 'pr', '--output', 'artifacts/pr-evidence.json']
  );

  for (const ownedArgument of ['--sha', '--workspace-state', '--ticket']) {
    assert.throws(
      () => normalizeForwardedArgs(['--profile', 'pr', ownedArgument, 'forged']),
      new RegExp(`${ownedArgument} is owned by the repository verifier`)
    );
  }
});

test('derives exact local evidence without inventing clean state', () => {
  const commands = [];
  const evidence = resolveGitEvidence({
    env: {},
    runGit: (args) => {
      commands.push(args);
      return args[0] === 'rev-parse' ? `${SHA}\n` : ' M package.json\n';
    },
  });

  assert.deepEqual(evidence, { sha: SHA, workspaceState: 'dirty' });
  assert.deepEqual(commands, [
    ['rev-parse', '--verify', 'HEAD'],
    ['status', '--porcelain=v1', '--untracked-files=normal'],
  ]);
});

test('GitHub Actions rejects a mismatched SHA or dirty checkout', () => {
  const runGit = (args) => (args[0] === 'rev-parse' ? SHA : '');

  assert.throws(
    () =>
      resolveGitEvidence({
        env: { GITHUB_ACTIONS: 'true', GITHUB_SHA: 'f'.repeat(40) },
        runGit,
      }),
    /GITHUB_SHA does not match checked-out HEAD/
  );

  assert.throws(
    () =>
      resolveGitEvidence({
        env: { GITHUB_ACTIONS: 'true', GITHUB_SHA: SHA },
        runGit: (args) => (args[0] === 'rev-parse' ? SHA : ' M package.json'),
      }),
    /GitHub Actions checkout is dirty/
  );
});

test('builds the single package CLI invocation with repository-owned evidence', () => {
  assert.deepEqual(
    buildMcpVerificationInvocation({
      forwardedArgs: ['--profile', 'pr', '--output', 'artifacts/pr-evidence.json'],
      sha: SHA,
      workspaceState: 'clean',
    }),
    {
      args: [
        '--filter',
        '@brainstrike/mcp-test-lab',
        'verify',
        '--',
        '--profile',
        'pr',
        '--output',
        'artifacts/pr-evidence.json',
        '--ticket',
        'BST-1486',
        '--sha',
        SHA,
        '--workspace-state',
        'clean',
      ],
      command: 'pnpm',
    }
  );
});

test('propagates child failure, signal termination, and spawn errors', () => {
  const args = ['--profile', 'pr', '--output', 'artifacts/pr-evidence.json'];
  const resolveEvidence = () => ({ sha: SHA, workspaceState: 'clean' });

  assert.equal(main(args, { resolveEvidence, spawn: () => ({ status: 17 }) }), 17);
  assert.throws(() => interpretChildResult({ signal: 'SIGTERM', status: null }), /SIGTERM/);
  assert.throws(
    () => interpretChildResult({ error: new Error('spawn failed'), status: null }),
    /spawn failed/
  );
});
