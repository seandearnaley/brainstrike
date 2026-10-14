import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProfileResetLease } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { app, session, utilityProcess } from 'electron';
import { getDbHostManager } from '../../db-host-manager';
import {
  closeDatabase,
  getDatabase,
  prepareDatabaseProfileReset,
  resetLocalDatabase,
} from '../../db-main';
import { createDesktopFactoryResetHandler } from '../../desktop-reset-platform';
import { createDesktopHostLease } from '../../host-lease-manager';

const userData = process.argv[2];
const entryPath = process.argv[3];
const mode = process.argv[4];
if (!(userData && entryPath && mode)) {
  throw new Error('Reset proof requires explicit userData, entry and mode');
}
const profile = path.join(userData, 'data', 'profiles', 'default');
process.env['NODE_ENV'] = 'test';
process.env['BRAINSTRIKE_DB_ROOT_PATH'] = path.join(userData, 'data');
process.env['BRAINSTRIKE_DB_PROFILE'] = 'default';
app.setPath('userData', userData);
const sessionDataPath = path.join(userData, 'session-data');
mkdirSync(sessionDataPath, { recursive: true });
app.setPath('sessionData', sessionDataPath);
app.on('window-all-closed', () => undefined);
const native = createDesktopHostLease({ entryPath, root: profile });
const events: string[] = [];
let pgExitObserved: { readonly pid: number | undefined; readonly code: number } | undefined;
const originalFork = utilityProcess.fork;
utilityProcess.fork = (...args: Parameters<typeof utilityProcess.fork>) => {
  const child = originalFork(...args);
  if (args[2]?.serviceName === 'brainstrike-db-host') {
    let pid = child.pid;
    child.once('spawn', () => {
      pid = child.pid;
    });
    child.once('exit', (code) => {
      pgExitObserved = { code, pid };
    });
  }
  return child;
};
let guard: ProfileResetLease | undefined;
let storageFailed = false;
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

app
  .whenReady()
  .then(async () => {
    const attachment = await native.acquire();
    const db = await getDatabase();
    await db.query('CREATE TABLE reset_adapter_proof (payload text)');
    await db.query("INSERT INTO reset_adapter_proof VALUES ('persisted')");
    const diagnostics = await getDbHostManager().getDiagnostics();
    const pgPid = diagnostics.hostPid;
    assert(typeof pgPid === 'number', 'Legacy DB host did not expose its real PID');
    if (typeof pgPid !== 'number') {
      throw new Error('Missing DB host PID');
    }
    const pgStart = processStartTime(pgPid);
    assert(typeof pgStart === 'string', 'Legacy DB host has no live process identity');
    const assertLegacyWriterExited = (): void => {
      assert(pgExitObserved?.pid === pgPid, 'Legacy utility exit was not observed');
      if (processStartTime(pgPid) !== pgStart) {
        return;
      }
      assert(process.platform === 'linux', 'Legacy writer remains live after its utility exit');
      try {
        const stat = readFileSync(`/proc/${pgPid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const fd = readdirSync(`/proc/${pgPid}/fd`);
        process.stderr.write(
          `RESET_PG_EXIT_OBSERVATION ${JSON.stringify({ fd, observedExit: pgExitObserved, parentPid: process.pid, pgPid, stat })}\n`
        );
        assert(fields[0] === 'Z', 'Legacy PG process is still running after exit');
        assert(Number(fields[1]) === process.pid, 'Zombie PG process has an unexpected parent');
        assert(fd.length === 0, 'Exited PG process still owns file descriptors');
      } catch (cause) {
        // Concurrent OS reaping is sufficient only when the original identity is
        // independently gone; an unreadable or still-live process is never proof.
        if (
          cause instanceof Error &&
          'code' in cause &&
          cause.code === 'ENOENT' &&
          processStartTime(pgPid) !== pgStart
        ) {
          return;
        }
        throw cause;
      }
    };
    mkdirSync(path.join(userData, 'Local Storage'), { recursive: true });
    mkdirSync(path.join(userData, 'logs'), { recursive: true });
    writeFileSync(path.join(userData, 'logs', 'reset-proof.log'), 'preserved');
    writeFileSync(path.join(profile, 'state.db'), 'state payload');
    writeFileSync(path.join(profile, 'index.db-wal'), 'index payload');
    const run = createDesktopFactoryResetHandler({
      completeSuccessfulReset: async () => {
        assert(guard?.isReleased === true, 'Renderer replacement preceded guard release');
        events.push('renderer');
      },
      logger: { error: () => undefined, info: () => undefined },
      prepareDatabaseProfileReset: async () => {
        guard = await prepareDatabaseProfileReset({
          retireProfileOwner: async () => {
            assertLegacyWriterExited();
            events.push('legacy-joined');
            await native.close();
            events.push('native-stop');
          },
        });
        events.push('guard');
        return guard;
      },
      resetLocalDatabase: async (lease) => {
        await resetLocalDatabase(lease);
        events.push('profile');
      },
      resetPersistentStorageAfterDataDeletion: async () => {
        assert(guard?.isReleased === false, 'Guard released before storage purge');
        assertLegacyWriterExited();
        assert(
          processStartTime(attachment.record.pid) !== attachment.record.start,
          'Owned native utility survived reset'
        );
        assert(!existsSync(path.join(profile, 'state.db')), 'State file survived profile reset');
        assert(
          !existsSync(path.join(profile, 'index.db-wal')),
          'Native index WAL survived profile reset'
        );
        assert(!existsSync(path.join(userData, 'Local Storage')), 'userData survived purge');
        assert(existsSync(RootLock.dirOf(profile)), 'userData purge removed reset namespace');
        let refused = false;
        try {
          await RootLock.acquire(profile);
        } catch (cause) {
          refused = cause instanceof Error && cause.name === 'RootLockedError';
        }
        assert(refused, 'Contender entered during Electron storage purge');
        events.push('storage');
        if (mode === 'storage-failure' && !storageFailed) {
          storageFailed = true;
          throw new Error('Injected Electron storage failure');
        }
        await session.defaultSession.clearStorageData();
      },
      runTransition: (work) => work(),
      runtimes: [],
      sessionDataPath,
      userDataPath: userData,
    }).reset;
    const first = await run();
    const retained = guard?.isReleased === false;
    const result = mode === 'storage-failure' ? await run() : first;
    if (mode === 'external-cli') {
      assert(
        !result.success && guard === undefined,
        'External CLI did not reject before guard acquisition'
      );
      assert(existsSync(path.join(profile, 'state.db')), 'External CLI reset deleted profile data');
      assert(
        existsSync(path.join(userData, 'Local Storage')),
        'External CLI reset staged userData'
      );
      assert(
        processStartTime(attachment.record.pid) === attachment.record.start,
        'Reset killed external CLI'
      );
    } else {
      assert(result.success, `Reset failed: ${result.message}`);
      assert(guard?.isReleased === true, 'Completed reset retained its guard');
      assert(
        existsSync(path.join(userData, 'logs', 'reset-proof.log')),
        'Reset deleted preserved logs'
      );
    }
    process.stdout.write(
      `RESET_ADAPTER_PROOF ${JSON.stringify({ events, first, nativePid: attachment.record.pid, nativeStart: attachment.record.start, pgPid, pgStart, result, retained })}\n`
    );
  })
  .then(async () => {
    await closeDatabase();
    await native.close();
    app.exit(0);
  })
  .catch((cause: unknown) => {
    process.stderr.write(`RESET_ADAPTER_FAILED ${String(cause)}\n`);
    app.exit(1);
  });
