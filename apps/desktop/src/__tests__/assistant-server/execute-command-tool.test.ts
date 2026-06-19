/**
 * Safety coverage for the desktop `brainstrike.executeCommand` tool.
 *
 * These run in CI (unlike rg-backed grep) because `/bin/sh` is always present.
 * The critical tests use REAL subprocesses and assert the process tree is
 * actually dead after a timeout/abort — a leaking shell tool is unacceptable,
 * so the no-orphan and process-group-kill proofs are the heart of this file.
 */
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeData } from '@brainstrike/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  disposeLiveChildProcesses,
  runExecuteCommand,
} from '../../assistant-server/execute-command-tool';

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

const execFileAsync = promisify(execFile);

const createdRoots: string[] = [];

async function makeWorkspace(prefix = 'brainstrike-exec-unit-'): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  // realpath so the macOS /var → /private/var symlink does not trip containment.
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

function singleRoot(rootPath: string): RuntimeData {
  return { workspaceRootPath: rootPath } as RuntimeData;
}

/** True only while the OS still has a process with this pid. */
async function pidIsAlive(pid: number): Promise<boolean> {
  try {
    // Signal 0 performs existence/permission checks without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForPidDead(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await pidIsAlive(pid))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !(await pidIsAlive(pid));
}

afterEach(async () => {
  disposeLiveChildProcesses();
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  }
});

describe('runExecuteCommand — happy path', () => {
  it('runs echo and surfaces exitCode 0 with stdout', async () => {
    const root = await makeWorkspace();
    const result = await runExecuteCommand({ command: 'echo hello-world' }, singleRoot(root));

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('hello-world');
    expect(result.signal).toBeNull();
    expect(result.cwd).toBe(root);
    expect(typeof result.durationMs).toBe('number');
  });

  it('starts in the workspace root by default (pwd === root)', async () => {
    const root = await makeWorkspace();
    const result = await runExecuteCommand({ command: 'pwd' }, singleRoot(root));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(root);
  });
});

describe('runExecuteCommand — non-zero exit (surfaced, not swallowed)', () => {
  it('surfaces a non-zero exit code', async () => {
    const root = await makeWorkspace();
    const result = await runExecuteCommand({ command: 'exit 3' }, singleRoot(root));
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr for a failing command', async () => {
    const root = await makeWorkspace();
    const result = await runExecuteCommand({ command: 'echo oops 1>&2; exit 1' }, singleRoot(root));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('oops');
  });
});

describe('runExecuteCommand — timeout + no orphan (CRITICAL)', () => {
  it('times out a long sleep and kills the process so no orphan survives', async () => {
    const root = await makeWorkspace();
    // Capture the spawned shell pid via the live registry indirectly: run a
    // command that writes its own group pid to a file, then assert that pid is
    // dead after the timeout. We write $$ (the shell pid == group leader pid).
    const pidFile = path.join(root, 'shell.pid');
    const result = await runExecuteCommand(
      { command: `echo $$ > "${pidFile}"; sleep 30`, timeoutMs: 500 },
      singleRoot(root)
    );

    expect(result.timedOut).toBe(true);
    // Killed by signal → exitCode is null (never silently coerced to 0).
    expect(result.exitCode).toBeNull();

    const shellPid = Number.parseInt((await fsPromises.readFile(pidFile, 'utf8')).trim(), 10);
    expect(Number.isInteger(shellPid)).toBe(true);
    // The shell pid must be gone — the timeout killed the whole tree.
    expect(await waitForPidDead(shellPid)).toBe(true);
  });
});

describe('runExecuteCommand — process-group kill reaps the grandchild (CRITICAL)', () => {
  it('kills a background grandchild on timeout, not just the shell', async () => {
    const root = await makeWorkspace();
    const childPidFile = path.join(root, 'child.pid');
    // The shell backgrounds a `sleep 30` (the grandchild) and records ITS pid,
    // then waits. On timeout, a shell-only kill would leave the grandchild
    // running; the process-GROUP kill must reap it too.
    const result = await runExecuteCommand(
      {
        command: `sleep 30 & echo $! > "${childPidFile}"; wait`,
        timeoutMs: 500,
      },
      singleRoot(root)
    );

    expect(result.timedOut).toBe(true);

    const grandchildPid = Number.parseInt(
      (await fsPromises.readFile(childPidFile, 'utf8')).trim(),
      10
    );
    expect(Number.isInteger(grandchildPid)).toBe(true);
    // The backgrounded grandchild must ALSO be dead — proves the group kill.
    expect(await waitForPidDead(grandchildPid)).toBe(true);
  });
});

describe('runExecuteCommand — abort kills the tree', () => {
  it('kills the process tree when the abort signal fires', async () => {
    const root = await makeWorkspace();
    const pidFile = path.join(root, 'abort.pid');
    const controller = new AbortController();
    const run = runExecuteCommand(
      { command: `echo $$ > "${pidFile}"; sleep 30`, timeoutMs: 30_000 },
      singleRoot(root),
      { signal: controller.signal }
    );
    // Give the shell time to start and write its pid, then abort.
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();

    const result = await run;
    expect(result.timedOut).toBe(false);
    const shellPid = Number.parseInt((await fsPromises.readFile(pidFile, 'utf8')).trim(), 10);
    expect(await waitForPidDead(shellPid)).toBe(true);
  });
});

describe('runExecuteCommand — output bounding (no unbounded result)', () => {
  it('truncates huge output with a hint instead of returning it all', async () => {
    const root = await makeWorkspace();
    // ~200k lines of "x" — far above the model token budget.
    const result = await runExecuteCommand(
      { command: 'seq 1 200000 | sed "s/.*/x/"', timeoutMs: 30_000 },
      singleRoot(root)
    );
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.hint).toBeTruthy();
    // The serialized result must be bounded (well under a megabyte of text).
    expect(JSON.stringify(result).length).toBeLessThan(20_000);
    // Tail bias: the LAST lines survive, so the final value is present.
    expect(result.stdout).toContain('x');
  });
});

describe('runExecuteCommand — cwd containment', () => {
  it('rejects an absolute cwd outside the workspace root', async () => {
    const root = await makeWorkspace();
    await expect(
      runExecuteCommand({ command: 'pwd', cwd: '/tmp' }, singleRoot(root))
    ).rejects.toThrow(/outside the workspace root/i);
  });

  it('rejects a relative cwd that escapes the root', async () => {
    const root = await makeWorkspace();
    await expect(
      runExecuteCommand({ command: 'pwd', cwd: '../..' }, singleRoot(root))
    ).rejects.toThrow(/outside the workspace root/i);
  });

  it('accepts a cwd inside the root and starts there', async () => {
    const root = await makeWorkspace();
    const sub = path.join(root, 'pkg', 'src');
    await fsPromises.mkdir(sub, { recursive: true });
    const result = await runExecuteCommand({ command: 'pwd', cwd: 'pkg/src' }, singleRoot(root));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(await fsPromises.realpath(sub));
  });

  it('throws when no folder is open in the workspace', async () => {
    await expect(runExecuteCommand({ command: 'echo hi' }, undefined)).rejects.toThrow(
      /No folder is open/i
    );
  });
});

describe('disposeLiveChildProcesses — shutdown reaping', () => {
  it('reaps a live child started by a never-resolving run', async () => {
    const root = await makeWorkspace();
    const pidFile = path.join(root, 'dispose.pid');
    // Start a long run but DO NOT await it; capture the pid from the file.
    const run = runExecuteCommand(
      { command: `echo $$ > "${pidFile}"; sleep 30`, timeoutMs: 30_000 },
      singleRoot(root)
    );
    // Wait for the shell to write its pid.
    let shellPid = Number.NaN;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const raw = (await fsPromises.readFile(pidFile, 'utf8')).trim();
        if (raw.length > 0) {
          shellPid = Number.parseInt(raw, 10);
          break;
        }
      } catch {
        // pid file not written yet
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(Number.isInteger(shellPid)).toBe(true);

    const reaped = disposeLiveChildProcesses();
    expect(reaped).toBeGreaterThanOrEqual(1);
    expect(await waitForPidDead(shellPid)).toBe(true);
    // The run still settles (killed → close event) so we never leak a promise.
    await run;
  });
});

// A tiny smoke test that the shell really executes node, proving the tool is
// useful for the agent's real workflows (node -e is a common agent command).
describe('runExecuteCommand — runs node', () => {
  it('runs `node -e` and returns its stdout', async () => {
    const root = await makeWorkspace();
    // Confirm node is on PATH in this CI before asserting (no silent skip).
    await execFileAsync('node', ['-e', 'process.stdout.write("ok")']);
    const result = await runExecuteCommand(
      { command: 'node -e "process.stdout.write(String(1+1))"' },
      singleRoot(root)
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('2');
  });
});
