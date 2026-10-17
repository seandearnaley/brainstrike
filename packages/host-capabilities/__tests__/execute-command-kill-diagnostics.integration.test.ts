/**
 * Teardown DIAGNOSTICS for the `brainstrike.executeCommand` tool.
 *
 * Split out of execute-command-tool.integration.test.ts, which owns the
 * no-orphan and process-group-kill proofs themselves. This file owns a narrower
 * question: which teardown outcomes are worth a log line. Both directions
 * matter — a warning that fires during NORMAL teardown trains readers to ignore
 * the one that fires during a real leak, and silencing it must not silence the
 * real leak (BST-1676).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createCredentialIsolatedChildEnvironment } from '@brainstrike/assistant-contract/credential-child-environment';
import type treeKill from 'tree-kill';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireWorkspaceMutationLease,
  disposeLiveChildProcesses,
} from '../src/native-tools/index.js';
import {
  createWindowsCommandProcess,
  type WindowsCommandJob,
} from '../src/windows-command-process.js';
import {
  packageWindowsCommandEntry,
  readPidWhenWritten,
  runCommand,
  singleRootRuntime,
  waitForPidDead,
} from './fixtures/execute-command.js';

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

/** Real Windows ownership, with failure injection only at the native authority being tested. */
async function windowsJobFixture(
  root: string,
  mode: 'normal' | 'denied-retirement' | 'wrong-identity'
) {
  const entry = packageWindowsCommandEntry();
  const native = createRequire(entry)('@brainstrike/windows-job-native') as {
    createCommandJob(): WindowsCommandJob;
  };
  const job = native.createCommandJob();
  const pidFile = path.join(root, 'windows-command.pid');
  const script = path.join(root, 'windows-command.cjs');
  await fsPromises.writeFile(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);`
  );
  const release = await acquireWorkspaceMutationLease(root, 'opaque');
  const closed = Promise.withResolvers<void>();
  const denied = new Error('Native command Job termination denied');
  let child: ChildProcess | undefined;
  let jobClosed = false;
  const onSettled = vi.fn(release);
  const env = {
    ...createCredentialIsolatedChildEnvironment(process.env),
    ELECTRON_RUN_AS_NODE: '1',
  };
  const owner = createWindowsCommandProcess({
    command: {
      argv: [script],
      cwd: root,
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
      executable: process.execPath,
      windowsVerbatimArguments: false,
    },
    createJob: () => ({
      assign: (identity) =>
        job.assign(
          mode === 'wrong-identity'
            ? { ...identity, creationTime: String(BigInt(identity.creationTime) + 1n) }
            : identity
        ),
      close: () => {
        job.close();
        jobClosed = true;
      },
      terminateAndWait: (exitCode) =>
        mode === 'denied-retirement' ? Promise.reject(denied) : job.terminateAndWait(exitCode),
    }),
    onOutput: () => {},
    onSettled,
    spawnWrapper: () => {
      child = spawn(process.execPath, [entry], {
        cwd: root,
        detached: false,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
      child.once('close', () => closed.resolve());
      return child;
    },
  });
  return {
    childPid: () => child?.pid,
    cleanup: async () => {
      await owner.retire().catch((error: unknown) => {
        if (mode !== 'denied-retirement' || error !== denied) {
          throw error;
        }
      });
      if (!jobClosed) {
        // Test-owned cleanup bypasses the injected denial, never the product's sticky failure.
        await job.terminateAndWait(1);
        await closed.promise;
        job.close();
        jobClosed = true;
      }
      release();
    },
    denied,
    onSettled,
    owner,
    pidFile,
  };
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
  await disposeLiveChildProcesses();
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
    if (process.platform === 'win32') {
      // Windows uses the native Job receipt, not a POSIX process-group errno.
      const fixture = await windowsJobFixture(root, 'normal');
      const run = fixture.owner.start();
      try {
        const pid = await readPidWhenWritten(fixture.pidFile);
        await Promise.all([fixture.owner.retire(), fixture.owner.retire()]);
        await run;
        expect(await waitForPidDead(pid)).toBe(true);
        expect(fixture.onSettled).toHaveBeenCalledTimes(1);
        expect(loggerWarnMock).not.toHaveBeenCalled();
      } finally {
        await fixture.cleanup();
      }
      return;
    }
    const pidFile = path.join(root, 'eperm-stub.pid');
    const command = await writeSleepingFixture(root, pidFile);
    const run = runCommand({ command, timeoutMs: 30_000 }, singleRootRuntime(root));
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
      await disposeLiveChildProcesses();
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
    if (process.platform === 'win32') {
      const fixture = await windowsJobFixture(root, 'denied-retirement');
      const run = fixture.owner.start().catch((error: unknown) => error);
      const stopWaiting = new AbortController();
      let admitted = false;
      try {
        const pid = await readPidWhenWritten(fixture.pidFile);
        await expect(fixture.owner.retire()).rejects.toBe(fixture.denied);
        expect(await run).toBe(fixture.denied);
        expect(process.kill(pid, 0)).toBe(true);
        const writer = acquireWorkspaceMutationLease(root, 'files', stopWaiting.signal).then(
          (finish) => {
            admitted = true;
            finish();
          },
          (error: unknown) => error
        );
        const finishDisjoint = await acquireWorkspaceMutationLease(`${root}-disjoint`, 'files');
        finishDisjoint();
        expect(admitted).toBe(false);
        expect(fixture.onSettled).not.toHaveBeenCalled();
        stopWaiting.abort(fixture.denied);
        expect(await writer).toBe(fixture.denied);
        await fixture.cleanup();
        expect(await waitForPidDead(pid)).toBe(true);
        await expect(fixture.owner.retire()).rejects.toBe(fixture.denied);
        expect(fixture.onSettled).not.toHaveBeenCalled();
      } finally {
        stopWaiting.abort(fixture.denied);
        await fixture.cleanup();
      }
      return;
    }
    const pidFile = path.join(root, 'eperm-live.pid');
    const command = await writeSleepingFixture(root, pidFile);
    const run = runCommand({ command, timeoutMs: 30_000 }, singleRootRuntime(root));
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
    let loggedTreeKillFailure = false;
    let survivorWasAlive = false;
    let disposal: Promise<number> | undefined;
    try {
      disposal = disposeLiveChildProcesses();
      loggedTreeKillFailure = await waitForWarn('tree-kill failed');
      survivorWasAlive = realKill(shellPid, 0);
    } finally {
      killSpy.mockRestore();
      // The denied native tree really survives. Restore every injected failure
      // before joining the installed platform implementation and command exit.
      await killFixtureTree(shellPid);
      await disposal;
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
  it.skipIf(process.platform === 'win32')(
    'does not log a kill failure when the group holds only unreaped members',
    async () => {
      const root = await makeWorkspace();
      const pidFile = path.join(root, 'zombie.pid');
      const run = runCommand(
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

      await disposeLiveChildProcesses();
      await run;
      // Let the asynchronous tree-kill callback land before asserting silence.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const warned = loggerWarnMock.mock.calls.map(([message]) => message);
      expect(warned).not.toContain('Process-group kill failed; falling back to tree-kill');
      expect(warned).not.toContain('tree-kill failed');
    }
  );

  // The other direction: silencing ESRCH/EPERM must not silence a REAL failure,
  // or the no-silent-fallbacks guarantee is gone.
  it('still logs a group-kill failure that is not the already-gone window', async () => {
    const root = await makeWorkspace();
    if (process.platform === 'win32') {
      // A real native identity mismatch must reject admission and physically join the wrapper.
      const fixture = await windowsJobFixture(root, 'wrong-identity');
      try {
        await expect(fixture.owner.start()).rejects.toThrow();
        const pid = fixture.childPid();
        expect(pid).toBeTypeOf('number');
        if (pid === undefined) {
          throw new Error('Expected the trusted wrapper to have actually started.');
        }
        expect(await waitForPidDead(pid)).toBe(true);
        await expect(fsPromises.stat(fixture.pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(fixture.onSettled).toHaveBeenCalledTimes(1);
      } finally {
        await fixture.cleanup();
      }
      return;
    }
    const pidFile = path.join(root, 'realfail.pid');
    const command = await writeSleepingFixture(root, pidFile);
    const run = runCommand({ command, timeoutMs: 30_000 }, singleRootRuntime(root));
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
      await disposeLiveChildProcesses();
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
