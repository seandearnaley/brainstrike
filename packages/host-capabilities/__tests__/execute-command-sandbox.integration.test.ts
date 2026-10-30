/**
 * BST-2328/2329: executeCommand inside the REAL OS fence (Seatbelt on macOS,
 * bubblewrap on Linux). A refused write comes back to the model as a sandboxed
 * failure that names the escape, and the escape runs the command outside.
 *
 * Skips loudly on a host that cannot fence, except in a lane that promised
 * the fence (BRAINSTRIKE_FENCE_DEPS_REQUIRED), where that is a lane defect.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFencedShell } from '@brainstrike/agent/fence-executor';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  disposeLiveChildProcesses,
  runExecuteCommand,
  SANDBOX_HINT,
} from '../src/native-tools/index.js';
import { packageWindowsCommandEntry, singleRootRuntime } from './fixtures/execute-command.js';

const fencedShell = createFencedShell({});

async function describeSkipReason(): Promise<string | undefined> {
  if (!fencedShell) {
    return `the OS fence is unavailable on '${process.platform}'`;
  }
  try {
    const probe = await fencedShell.wrap({
      command: 'true',
      cwd: tmpdir(),
      root: tmpdir(),
      shell: '/bin/sh',
      signal: new AbortController().signal,
    });
    probe.release();
    return;
  } catch (error) {
    return `the OS fence is not ready on this host: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const skipReason = await describeSkipReason();
if (skipReason && process.env['BRAINSTRIKE_FENCE_DEPS_REQUIRED'] === '1') {
  throw new Error(`execute-command-sandbox.integration promised a fence: ${skipReason}`);
}
if (skipReason) {
  console.warn(`[execute-command-sandbox.integration] SKIPPED — ${skipReason}`);
}

describe.skipIf(skipReason !== undefined)('executeCommand inside the real OS fence', () => {
  const sandbox = async () => fencedShell;
  let root = '';
  let outside = '';

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'bs-execute-command-sandbox-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'bs-execute-command-outside-')));
  });
  afterEach(async () => {
    await disposeLiveChildProcesses();
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  });

  const run = (command: string, dangerouslyDisableSandbox?: true) =>
    runExecuteCommand(
      { command, ...(dangerouslyDisableSandbox ? { dangerouslyDisableSandbox } : {}) },
      singleRootRuntime(root),
      { sandbox, windowsCommandEntry: packageWindowsCommandEntry }
    );

  test('a write in the open folder works and says it was sandboxed', async () => {
    const result = await run('printf ok > inside.txt');
    expect(result).toMatchObject({ exitCode: 0, sandboxed: true });
    expect(await readFile(join(root, 'inside.txt'), 'utf8')).toBe('ok');
  });

  test('a write outside it is refused, and the model is told why and how to escape', async () => {
    const target = join(outside, 'escaped.txt');
    const result = await run(`printf no > '${target}'`);
    expect(result.exitCode).not.toBe(0);
    expect(result.sandboxed).toBe(true);
    expect(result.hint).toContain(SANDBOX_HINT);
    expect(existsSync(target)).toBe(false);
  });

  test('the escape runs the same command outside the sandbox', async () => {
    const target = join(outside, 'escaped.txt');
    const result = await run(`printf yes > '${target}'`, true);
    expect(result).toMatchObject({ exitCode: 0, sandboxed: false });
    expect(await readFile(target, 'utf8')).toBe('yes');
  });
});
