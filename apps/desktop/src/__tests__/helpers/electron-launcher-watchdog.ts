import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ElectronApplication } from 'playwright';

/** Acquire Windows Job ownership before Playwright creates the app's process tree. */
export async function launchAppWithLauncher(
  launch: () => Promise<ElectronApplication>
): Promise<ElectronApplication> {
  if (process.platform === 'win32') {
    const windowsJob: typeof import('@brainstrike/windows-job-native') = createRequire(
      import.meta.url
    )('@brainstrike/windows-job-native');
    windowsJob.initialize();
    return launch();
  }

  const application = await launch();
  const appPid = application.process().pid;
  if (appPid) {
    killAppWithLauncher(appPid);
  }
  return application;
}

/**
 * On POSIX, Playwright launches Electron detached, as the leader of its own process
 * group, and kills it only from the launcher's exit and signal handlers. A
 * launcher killed outright (SIGKILL, or a tool timeout that kills the test
 * run's process group) runs none of them, and the app lives on under launchd.
 *
 * This detached watcher kills the app's process group once the launcher is
 * gone. It exits by itself as soon as the app does, so it never outlives the
 * app it watches.
 */
function killAppWithLauncher(appPid: number): void {
  const watcher = spawn(
    '/bin/sh',
    [
      '-c',
      'while kill -0 "$1" 2>/dev/null && kill -0 "$2" 2>/dev/null; do sleep 1; done; kill -0 "$1" 2>/dev/null || kill -KILL -"$2" 2>/dev/null',
      'electron-launcher-watchdog',
      String(process.pid),
      String(appPid),
    ],
    { detached: true, stdio: 'ignore' }
  );
  watcher.unref();
}
