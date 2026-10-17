import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProfileResetLease } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { app, session } from 'electron';
import { resolveDesktopDatabaseProfileDirectory } from '../../desktop-database-location';
import { createDesktopProfileResetOwner } from '../../desktop-profile-reset-owner';
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
// Main's composition: the profile reset owner retires the native owner, then
// holds the canonical profile lock through deletion.
const profileReset = createDesktopProfileResetOwner({
  profilePath: resolveDesktopDatabaseProfileDirectory,
  retireProfile: async () => {
    await native.close();
    events.push('native-stop');
  },
});
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
        guard = await profileReset.prepare();
        events.push('guard');
        return guard;
      },
      resetLocalDatabase: async (lease) => {
        await profileReset.clear(lease);
        events.push('profile');
      },
      resetPersistentStorageAfterDataDeletion: async () => {
        assert(guard?.isReleased === false, 'Guard released before storage purge');
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
      `RESET_ADAPTER_PROOF ${JSON.stringify({ events, first, nativePid: attachment.record.pid, nativeStart: attachment.record.start, result, retained })}\n`
    );
  })
  .then(async () => {
    await native.close();
    app.exit(0);
  })
  .catch((cause: unknown) => {
    process.stderr.write(`RESET_ADAPTER_FAILED ${String(cause)}\n`);
    app.exit(1);
  });
