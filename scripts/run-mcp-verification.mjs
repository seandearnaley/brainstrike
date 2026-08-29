#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_OWNED_ARGUMENTS = ['--sha', '--ticket', '--workspace-state'];

export function normalizeForwardedArgs(rawArgs) {
  const forwardedArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : [...rawArgs];

  for (const argument of forwardedArgs) {
    const ownedArgument = REPOSITORY_OWNED_ARGUMENTS.find(
      (candidate) => argument === candidate || argument.startsWith(`${candidate}=`)
    );
    if (ownedArgument) {
      throw new Error(`${ownedArgument} is owned by the repository verifier`);
    }
  }

  return forwardedArgs;
}

function runGitCommand(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function resolveGitEvidence({ env = process.env, runGit = runGitCommand } = {}) {
  const sha = runGit(['rev-parse', '--verify', 'HEAD']).trim();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error('git rev-parse did not return a full lowercase commit SHA');
  }

  const status = runGit(['status', '--porcelain=v1', '--untracked-files=normal']);
  const workspaceState = status.trim().length === 0 ? 'clean' : 'dirty';

  if (env.GITHUB_ACTIONS === 'true') {
    if (!(env.GITHUB_SHA && SHA_PATTERN.test(env.GITHUB_SHA))) {
      throw new Error('GitHub Actions requires a full lowercase GITHUB_SHA');
    }
    if (env.GITHUB_SHA !== sha) {
      throw new Error('GITHUB_SHA does not match checked-out HEAD');
    }
    if (workspaceState !== 'clean') {
      throw new Error('GitHub Actions checkout is dirty before MCP verification');
    }
  }

  return { sha, workspaceState };
}

export function buildMcpVerificationInvocation({ forwardedArgs, sha, workspaceState }) {
  return {
    args: [
      '--filter',
      '@brainstrike/mcp-test-lab',
      'verify',
      '--',
      ...forwardedArgs,
      '--ticket',
      'BST-1486',
      '--sha',
      sha,
      '--workspace-state',
      workspaceState,
    ],
    command: 'pnpm',
  };
}

export function interpretChildResult(result) {
  if (result.error) {
    throw result.error;
  }
  if (result.status === null) {
    throw new Error(`MCP verification terminated by signal ${result.signal ?? 'unknown'}`);
  }
  return result.status;
}

export function main(
  rawArgs = process.argv.slice(2),
  { resolveEvidence = resolveGitEvidence, spawn = spawnSync } = {}
) {
  const forwardedArgs = normalizeForwardedArgs(rawArgs);
  const evidence = resolveEvidence();
  const invocation = buildMcpVerificationInvocation({ forwardedArgs, ...evidence });
  const result = spawn(invocation.command, invocation.args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  return interpretChildResult(result);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
