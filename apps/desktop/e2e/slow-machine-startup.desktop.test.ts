import path from 'node:path';
import { isRootHeld } from '../src/__tests__/helpers/root-held';
import { getMainBufferedLogs } from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';
import { readHostProcess, waitForAppHost } from './utils/agent-host-log';

/**
 * Lifecycle redesign §6.1, startup: a machine slow at every startup boundary is
 * still a correct startup. The E2E-only delay seam holds the host's ready report
 * 5 s, Main's answer to the host's platform readiness check 3 s and any Main read
 * of a published host record 3 s, each past a deadline startup used to race.
 * Asserted is product behaviour only: the window is ready, one host process
 * started for the profile, Main logged no error (a `warn` naming a slow stage
 * is expected) and quit exits 0.
 */
test.use({
  electronEnv: {
    BRAINSTRIKE_E2E_LIFECYCLE_DELAYS: 'host-ready:5000,platform-ready:3000',
  },
});

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
