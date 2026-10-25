import path from 'node:path';
import { RootLock } from '@brainstrike/state-store';
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

  // One host started for this fresh profile: its Root was acquired exactly once
  // (generation 0), by the host that published the record.
  const userData = electron.getUserDataDir();
  const host = await readHostProcess(userData);
  expect(RootLock.inspect(path.join(userData, 'profiles', 'test'))).toMatchObject({
    gen: 0,
    owner: { pid: host.pid, start: host.start },
  });

  const records = (await getMainBufferedLogs(page)) as readonly BufferedLogRecord[];
  const errors = records.filter((record) => record.level === 'error' || record.level === 'fatal');
  expect(errors).toEqual([]);

  await electron.dispose();
  expect(mainProcess.exitCode).toBe(0);
  expect(mainProcess.signalCode).toBeNull();
});
