/**
 * Desktop E2E: Main's process ends without a quit (a crash, Task Manager, a test runner's force
 * kill), and nothing it started outlives it. The agent host and every Chromium child end, and
 * the next launch opens the same profile. On Windows, Main holds the host in a kill-on-close Job,
 * so even a host that cannot run (frozen here) ends with Main.
 */
import { joinProcessExit, processStartTime } from '@brainstrike/state-store';
import { expect, test } from './fixtures/electron-fixture';
import { readHostProcess, waitForAppHost } from './utils/agent-host-log';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { suspendProcess } from './utils/suspend-process';

interface Identity {
  readonly pid: number;
  readonly start: string;
}

test.describe('A killed Main', () => {
  test.setTimeout(180_000);

  for (const host of ['running', 'frozen'] as const) {
    test(`ends its ${host} agent host and every Chromium child, and the profile reopens`, async ({
      electron,
      window,
    }) => {
      test.skip(
        host === 'frozen' && process.platform !== 'win32',
        'Only Windows has a kill-on-close Job; a stopped POSIX host waits for its signal.'
      );
      const { waitForAppReady } = await loadElectronHelpers();
      await waitForAppReady(window);
      await waitForAppHost(window);
      const userDataDir = electron.getUserDataDir();
      const agentHost = await readHostProcess(userDataDir);
      const context = await electron.ensureContext();
      const chromiumPids = await context.app.evaluate(({ app }) =>
        app
          .getAppMetrics()
          .filter((metric) => metric.type !== 'Browser')
          .map((metric) => metric.pid)
      );
      const children: Identity[] = [agentHost];
      for (const pid of chromiumPids) {
        const start = processStartTime(pid);
        if (start !== null && pid !== agentHost.pid) {
          children.push({ pid, start });
        }
      }
      expect(children.length).toBeGreaterThan(1);
      if (host === 'frozen') {
        await suspendProcess(agentHost.pid);
      }
      await electron.endOutOfBand(async (mainProcess) => {
        const closed = new Promise((resolve) => mainProcess.once('close', resolve));
        mainProcess.kill('SIGKILL');
        await closed;
      }, 'SIGKILL');
      await Promise.all(children.map(({ pid, start }) => joinProcessExit(pid, start)));
      const restarted = (await electron.restart()).window;
      await waitForAppReady(restarted);
      await waitForAppHost(restarted);
      expect((await readHostProcess(userDataDir)).pid).not.toBe(agentHost.pid);
    });
  }
});
