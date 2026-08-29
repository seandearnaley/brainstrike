#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSpawnInvocation } from './spawn-command.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const OUTPUT_PATTERN = /^artifacts\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.json$/;

export function normalizeForwardedArgs(rawArgs) {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : [...rawArgs];
  if (args.length !== 4) {
    throw new Error('MCP verification requires exactly --profile and --output');
  }
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== '--profile' && flag !== '--output') || !value || values.has(flag)) {
      throw new Error('MCP verification accepts one --profile and one --output');
    }
    values.set(flag, value);
  }
  const profile = values.get('--profile');
  const output = values.get('--output');
  if (profile !== 'pr' && profile !== 'exhaustive') {
    throw new Error('MCP verification profile must be pr or exhaustive');
  }
  if (!(OUTPUT_PATTERN.test(output) && output.split('/').every((part) => part !== '..'))) {
    throw new Error('MCP verification output must be a safe JSON path below artifacts/');
  }
  return ['--profile', profile, '--output', output];
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

export function buildMcpVerificationInvocation({ forwardedArgs }, platform = process.platform) {
  return createSpawnInvocation(
    'pnpm',
    ['--filter', '@brainstrike/mcp-test-lab', 'verify', '--', ...forwardedArgs],
    platform
  );
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
  // Guard GitHub identity here; the package independently derives what it records.
  resolveEvidence();
  const invocation = buildMcpVerificationInvocation({ forwardedArgs });
  const result = spawn(invocation.command, invocation.args, {
    cwd: REPO_ROOT,
    env: process.env,
    shell: invocation.shell,
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
