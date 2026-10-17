import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { expect, test } from './fixtures/electron-fixture';
import { readHostProcess, waitForAppHost, withAppHost } from './utils/agent-host-log';
import { loadElectronHelpers } from './utils/load-electron-helpers';

const CLOSE_TIMEOUT_MS = 10_000;
const PROBE_TITLE = 'Shutdown signal committed thread';
test.use({ electronEnv: { LOG_LEVEL: 'info' } });

async function commitProbe(userDataDir: string): Promise<string> {
  return await withAppHost(userDataDir, async (host) => {
    const { threadId } = await host.request('thread/start', { commandId: randomUUID() });
    await host.request('thread/update', { commandId: randomUUID(), threadId, title: PROBE_TITLE });
    return threadId;
  });
}

async function assertProbe(userDataDir: string, threadId: string): Promise<void> {
  const snapshot = await withAppHost(userDataDir, (host) => host.request('thread/list', {}));
  expect(snapshot.threads.find((thread) => thread.threadId === threadId)?.title).toBe(PROBE_TITLE);
}

/** Verify both the profile's published host record and its physical Root owner before signalling. */
async function ownedHost(
  userDataDir: string
): Promise<{ pid: number; start: string; root: string }> {
  const root = realpathSync(path.join(userDataDir, 'profiles', 'test'));
  const host = await readHostProcess(userDataDir);
  const lock = RootLock.inspect(root);
  expect(lock?.owner).toMatchObject({ pid: host.pid, root, start: host.start });
  expect(lock?.owner.released).not.toBe(true);
  expect(processStartTime(host.pid)).toBe(host.start);
  expect(RootLock.isFlockHeld(root)).toBe(true);
  return { ...host, root };
}

function captureOutput(mainProcess: ChildProcess): () => string {
  const chunks: string[] = [];
  const capture = (chunk: Buffer) => chunks.push(chunk.toString());
  mainProcess.stdout?.on('data', capture);
  mainProcess.stderr?.on('data', capture);
  return () => chunks.join('');
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

function requirePid(mainProcess: ChildProcess): number {
  if (mainProcess.pid === undefined) {
    throw new Error('The Electron main process has no pid');
  }
  return mainProcess.pid;
}

test.describe('Shutdown signals join the profile owner', () => {
  test.skip(process.platform === 'win32', 'Windows has no catchable POSIX process signals.');
  test.setTimeout(240_000);

  test('a repeated dev-tree teardown releases the Root and committed state reopens', async ({
    electron,
    window,
  }, testInfo) => {
    const { waitForAppReady } = await loadElectronHelpers();
    await waitForAppReady(window);
    await waitForAppHost(window);
    const userDataDir = electron.getUserDataDir();
    const threadId = await commitProbe(userDataDir);
    const host = await ownedHost(userDataDir);
    let readOutput = () => '';
    let ended: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null =
      null;
    try {
      await electron.endOutOfBand(async (mainProcess) => {
        const mainPid = requirePid(mainProcess);
        readOutput = captureOutput(mainProcess);
        const closed = once(mainProcess, 'close', {
          signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
        });
        signal(host.pid, 'SIGINT');
        signal(mainPid, 'SIGINT');
        signal(mainPid, 'SIGINT');
        signal(host.pid, 'SIGTERM');
        signal(mainPid, 'SIGTERM');
        await closed;
        ended = { code: mainProcess.exitCode, signal: mainProcess.signalCode };
      });
    } finally {
      await testInfo.attach('shutdown-signals-process-log', {
        body: readOutput(),
        contentType: 'text/plain',
      });
    }
    expect(ended).toEqual({ code: 0, signal: null });
    expect(readOutput()).toContain('Received shutdown signal');
    expect(readOutput()).toContain('Shutdown already in progress; ignoring signal');
    expect(readOutput()).toContain('Graceful shutdown completed');
    expect(readOutput()).not.toContain('forcing exit');
    expect(processStartTime(host.pid)).not.toBe(host.start);
    expect(RootLock.isFlockHeld(host.root)).toBe(false);
    expect(RootLock.inspect(host.root)?.owner.released).toBe(true);
    const restarted = (await electron.restart()).window;
    await waitForAppReady(restarted);
    await waitForAppHost(restarted);
    await assertProbe(userDataDir, threadId);
    const reopened = await ownedHost(userDataDir);
    expect(reopened.pid).not.toBe(host.pid);
  });

  test('negative control: a verified disposable host crash retains its stale record and committed state recovers', async ({
    electron,
    window,
  }, testInfo) => {
    const { waitForAppReady } = await loadElectronHelpers();
    await waitForAppReady(window);
    await waitForAppHost(window);
    const userDataDir = electron.getUserDataDir();
    const threadId = await commitProbe(userDataDir);
    const host = await ownedHost(userDataDir);
    const context = await electron.ensureContext();
    const readOutput = captureOutput(context.app.process());
    // Owner-authorized abnormal child control. Main is never force-killed; PID/start/profile all match above.
    signal(host.pid, 'SIGABRT');
    await expect
      .poll(() => processStartTime(host.pid), { timeout: CLOSE_TIMEOUT_MS })
      .not.toBe(host.start);
    expect(RootLock.inspect(host.root)?.owner).toMatchObject({ pid: host.pid, start: host.start });
    expect(RootLock.inspect(host.root)?.owner.released).not.toBe(true);
    try {
      await electron.closeForStateSeeding();
    } finally {
      await testInfo.attach('crashed-host-process-log', {
        body: readOutput(),
        contentType: 'text/plain',
      });
    }
    expect(RootLock.isFlockHeld(host.root)).toBe(false);
    const restarted = (await electron.restart()).window;
    await waitForAppReady(restarted);
    await waitForAppHost(restarted);
    await assertProbe(userDataDir, threadId);
    const recovered = await ownedHost(userDataDir);
    expect(recovered.pid).not.toBe(host.pid);
  });
});
