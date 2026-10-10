/**
 * Teardown DIAGNOSTICS for the desktop `brainstrike.executeCommand` tool.
 *
 * Split out of execute-command-tool.integration.test.ts, which owns the
 * no-orphan and process-group-kill proofs themselves. This file owns a narrower
 * question: which teardown outcomes are worth a log line. Both directions
 * matter — a warning that fires during NORMAL teardown trains readers to ignore
 * the one that fires during a real leak, and silencing it must not silence the
 * real leak (BST-1676).
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type treeKill from 'tree-kill';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposeLiveChildProcesses,
  runExecuteCommand,
} from '../../assistant-server/execute-command-tool';
import { readPidWhenWritten, singleRootRuntime, waitForPidDead } from './_tool-test-helpers';

const { loggerDebugMock, loggerInfoMock, loggerWarnMock } = vi.hoisted(() => ({
  loggerDebugMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      ...actual.createLogger('test'),
      debug: loggerDebugMock,
      info: loggerInfoMock,
      warn: loggerWarnMock,
    }),
  };
});

// Windows tree-kill uses taskkill, so process.kill denial cannot leave a live
// survivor there. Fail only the owned tree's vendor callback while armed; every
// other request still executes the installed implementation.
const treeKillDenial = vi.hoisted(() => ({ pid: undefined as number | undefined }));

vi.mock('tree-kill', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof treeKill }>();
  return {
    default: (pid: number, signal: string | number, callback: (error?: Error) => void): void => {
      if (pid !== treeKillDenial.pid) {
        actual.default(pid, signal, callback);
        return;
      }
      const denied = new Error('kill EPERM') as NodeJS.ErrnoException;
      denied.code = 'EPERM';
      queueMicrotask(() => callback(denied));
    },
  };
});

const createdRoots: string[] = [];

async function writeSleepingFixture(root: string, pidFile: string): Promise<string> {
  await fsPromises.writeFile(
    path.join(root, 'sleeping-fixture.cjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.ppid));
setTimeout(() => {}, 30_000);`,
    'utf8'
  );
  // Preserve the shell parent and Node's exit status on shells that otherwise
  // replace themselves with their final command.
  const command = 'node sleeping-fixture.cjs';
  return process.platform === 'win32' ? command : `${command}; exit $?`;
}

async function killFixtureTree(pid: number): Promise<void> {
  const actual = await vi.importActual<{ default: typeof treeKill }>('tree-kill');
  await new Promise<void>((resolve, reject) => {
    actual.default(pid, 'SIGKILL', (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function makeWorkspace(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-exec-kill-'));
  // realpath so the macOS /var → /private/var symlink does not trip containment.
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

/**
 * Poll for a logged warning instead of sleeping a fixed span. tree-kill's
 * ps/pgrep walk is async, and a fixed wait races the spy restore on a loaded
 * runner — the real kill would land, the tree would die, and the assertion
 * would fail for a reason unrelated to what it is testing.
 */
async function waitForWarn(message: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (loggerWarnMock.mock.calls.some(([logged]) => logged === message)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

beforeEach(() => {
  loggerDebugMock.mockReset();
  loggerInfoMock.mockReset();
  loggerWarnMock.mockReset();
});

afterEach(async () => {
  disposeLiveChildProcesses();
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

describe('killProcessTree — teardown log diagnostics', () => {
  // The EPERM arm, stubbed so it runs on EVERY platform. Linux never produces
  // EPERM for this window (unreaped members stay in the group and kill(2)
  // succeeds), so the OS-level test below cannot cover the changed branch on the
  // primary CI runner — this one does.
  it('does not log when the group signal reports EPERM but the tree is gone', async () => {
    const root = await makeWorkspace();
    const pidFile = path.join(root, 'eperm-stub.pid');
    const command = await writeSleepingFixture(root, pidFile);
    const run = runExecuteCommand({ command, timeoutMs: 30_000 }, singleRootRuntime(root));
    const shellPid = await readPidWhenWritten(pidFile);
    loggerWarnMock.mockReset();

    const realKill = process.kill.bind(process);
    // Only the GROUP signal is denied; tree-kill's per-pid signals go through,
    // which is the benign shape: nothing survived, the group just had nothing
    // signalable left in it.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      targetPid: number,
      killSignal?: string | number
    ) => {
      if (targetPid < 0) {
        const denied = new Error('kill EPERM') as NodeJS.ErrnoException;
        denied.code = 'EPERM';
        throw denied;
      }
      return realKill(targetPid, killSignal as NodeJS.Signals);
    }) as typeof process.kill);
    try {
      disposeLiveChildProcesses();
    } finally {
      killSpy.mockRestore();
    }
    expect(await waitForPidDead(shellPid)).toBe(true);
    await run;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const warned = loggerWarnMock.mock.calls.map(([message]) => message);
    expect(warned).not.toContain('Process-group kill failed; falling back to tree-kill');
    expect(warned).not.toContain('tree-kill failed');
    // Quiet is not the same as invisible. tree-kill only walks the PPID tree, so
    // a reparented group member can escape it entirely; the debug line is the
    // only trace that window leaves and must not be dropped as "noise".
    expect(loggerDebugMock.mock.calls.map(([message]) => message)).toContain(
      'Process-group kill found nothing signalable'
    );
  });

  // EPERM is INCONCLUSIVE, not proof of success: this tool runs arbitrary user
  // commands, so a live `sudo`/setuid member can sit in the group and make
  // killpg report EPERM while a real orphan survives. Silencing the group-kill
  // warn must not silence that — tree-kill is what resolves the ambiguity.
  it('still logs when EPERM hides a member that really survived', async () => {
    const root = await makeWorkspace();
    const pidFile = path.join(root, 'eperm-live.pid');
    const command = await writeSleepingFixture(root, pidFile);
    const run = runExecuteCommand({ command, timeoutMs: 30_000 }, singleRootRuntime(root));
    const shellPid = await readPidWhenWritten(pidFile);
    loggerWarnMock.mockReset();

    const realKill = process.kill.bind(process);
    // Deny EVERY signal, group and per-pid alike — the unsignalable-survivor
    // shape. Signal 0 still probes so tree-kill can find the tree to fail on.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      targetPid: number,
      killSignal?: string | number
    ) => {
      if (killSignal === 0) {
        return realKill(targetPid, 0);
      }
      const denied = new Error('kill EPERM') as NodeJS.ErrnoException;
      denied.code = 'EPERM';
      throw denied;
    }) as typeof process.kill);
    if (process.platform === 'win32') {
      treeKillDenial.pid = shellPid;
    }
    let loggedTreeKillFailure = false;
    let survivorWasAlive = false;
    try {
      disposeLiveChildProcesses();
      loggedTreeKillFailure = await waitForWarn('tree-kill failed');
      survivorWasAlive = realKill(shellPid, 0);
    } finally {
      killSpy.mockRestore();
      treeKillDenial.pid = undefined;
      // The denied native tree really survives. Restore every injected failure
      // before joining the installed platform implementation and command exit.
      await killFixtureTree(shellPid);
      await run;
    }

    // Tear the tree down BEFORE asserting, guarded: the spy denied every kill,
    // so this test is the one most likely to leave the 30s sleep behind, and an
    // assertion failure must not be what decides whether it does.
    expect(await waitForPidDead(shellPid)).toBe(true);
    await run;

    expect(loggedTreeKillFailure).toBe(true);
    expect(survivorWasAlive).toBe(true);
  });

  // The real-kernel proof. Darwin's killpg1() drops zombies from its signalable
  // count and reports EPERM; Linux keeps them in the group and succeeds, so the
  // precondition is kernel-appropriate and the stubbed test above is what covers
  // the branch itself on Linux CI.
  it('does not log a kill failure when the group holds only unreaped members', async () => {
    const root = await makeWorkspace();
    const pidFile = path.join(root, 'zombie.pid');
    const run = runExecuteCommand(
      { command: `echo $$ > "${pidFile}"; sleep 30`, timeoutMs: 30_000 },
      singleRootRuntime(root)
    );
    const shellPid = await readPidWhenWritten(pidFile);
    loggerWarnMock.mockReset();

    const unreapedState = process.platform === 'darwin' ? 'EPERM' : 'alive';
    process.kill(-shellPid, 'SIGKILL');
    // Spin rather than await: blocking the event loop keeps this process from
    // reaping the child, holding the group in the exact state teardown races
    // against instead of letting it settle to ESRCH first.
    const spinDeadline = Date.now() + 1000;
    let groupState: string | undefined;
    while (Date.now() < spinDeadline) {
      try {
        process.kill(-shellPid, 0);
        groupState = 'alive';
      } catch (error) {
        groupState = (error as NodeJS.ErrnoException).code ?? 'unknown';
      }
      // ESRCH means it was reaped before we could observe the window; break out
      // and fail fast with a clear state rather than spinning the full second.
      if (groupState === unreapedState || groupState === 'ESRCH') {
        break;
      }
    }
    expect(groupState).toBe(unreapedState);

    disposeLiveChildProcesses();
    await run;
    // Let the asynchronous tree-kill callback land before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const warned = loggerWarnMock.mock.calls.map(([message]) => message);
    expect(warned).not.toContain('Process-group kill failed; falling back to tree-kill');
    expect(warned).not.toContain('tree-kill failed');
  });

  // The other direction: silencing ESRCH/EPERM must not silence a REAL failure,
  // or the no-silent-fallbacks guarantee is gone.
  it('still logs a group-kill failure that is not the already-gone window', async () => {
    const root = await makeWorkspace();
    const pidFile = path.join(root, 'realfail.pid');
    const command = await writeSleepingFixture(root, pidFile);
    const run = runExecuteCommand({ command, timeoutMs: 30_000 }, singleRootRuntime(root));
    const shellPid = await readPidWhenWritten(pidFile);
    loggerWarnMock.mockReset();

    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      targetPid: number,
      killSignal?: string | number
    ) => {
      if (targetPid < 0) {
        const denied = new Error('kill EACCES') as NodeJS.ErrnoException;
        denied.code = 'EACCES';
        throw denied;
      }
      return realKill(targetPid, killSignal as NodeJS.Signals);
    }) as typeof process.kill);
    try {
      disposeLiveChildProcesses();
    } finally {
      killSpy.mockRestore();
    }
    // Disposal uses the real platform tree-kill implementation; join physical
    // termination before checking diagnostics.
    expect(await waitForPidDead(shellPid)).toBe(true);
    await run;

    expect(loggerWarnMock.mock.calls.map(([message]) => message)).toContain(
      'Process-group kill failed; falling back to tree-kill'
    );
  });
});
