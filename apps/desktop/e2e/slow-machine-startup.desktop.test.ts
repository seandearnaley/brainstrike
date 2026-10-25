import path from 'node:path';
import { isRootHeld } from '../src/__tests__/helpers/root-held';
import { getMainBufferedLogs } from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';
import { readHostProcess, waitForAppHost } from './utils/agent-host-log';

/**
 * Lifecycle redesign §6.1, startup: a slow machine (the standard hosted runners)
 * is still a correct startup, because no startup boundary races a deadline.
 * Asserted is product behaviour only: the window is ready, one host process
 * started for the profile, Main logged no error and quit exits 0.
 */

interface BufferedLogRecord {
  readonly level?: string;
  readonly message?: string;
  readonly scope?: string;
}

test('a slow machine starts one agent host without errors and quits cleanly', async ({
  electron,
  window: page,
}) => {
  test.setTimeout(180_000);
  const mainProcess = (await electron.ensureContext()).app.process();
  // Main answers the window's host connection only once its profile host is attached.
  await waitForAppHost(page);

  // The host Main reports is alive and holds the profile's Root.
  const userData = electron.getUserDataDir();
  const host = await readHostProcess(userData);
  expect(process.kill(host.pid, 0)).toBe(true);
  expect(isRootHeld(path.join(userData, 'profiles', 'test'))).toBe(true);

  const records = (await getMainBufferedLogs(page)) as readonly BufferedLogRecord[];
  const errors = records.filter((record) => record.level === 'error' || record.level === 'fatal');
  expect(errors).toEqual([]);

  await electron.dispose();
  expect(mainProcess.exitCode).toBe(0);
  expect(mainProcess.signalCode).toBeNull();
});
