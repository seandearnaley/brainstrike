// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireProfileResetLease } from '@brainstrike/host-lease';
import { RootLock } from '@brainstrike/state-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDatabaseLocation } from '../../database-location';
import { resetDesktopApplicationData } from '../../desktop-factory-reset';

/**
 * Packaged macOS keeps the database at `<userData>/data/profiles/default/pgdata`,
 * i.e. INSIDE the directory factory reset wipes wholesale. Real filesystem, so
 * the assertions are about the actual layout, not about mocked rename calls.
 */
describe('factory reset with the packaged macOS database layout', () => {
  let userData: string;

  beforeEach(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'brainstrike-reset-layout-'));
  });

  afterEach(() => {
    rmSync(userData, { force: true, recursive: true });
  });

  function seedPackagedProfile(): { pgdata: string; root: string } {
    const { profile, rootPath } = resolveDatabaseLocation({
      env: {},
      isPackaged: true,
      isTestRun: false,
      paths: { documents: '/unused', home: '/unused', userData },
      platform: 'darwin',
      productDirName: 'BrainStrike Desktop',
      readGitContext: () => null,
    });
    const pgdata = path.join(rootPath, 'profiles', profile, 'pgdata');
    mkdirSync(pgdata, { recursive: true });
    writeFileSync(path.join(pgdata, 'PG_VERSION'), '18');
    mkdirSync(path.join(rootPath, 'backups', `${profile}-2026-09-29`), { recursive: true });
    mkdirSync(path.join(userData, 'Local Storage'));
    mkdirSync(path.join(userData, 'logs'));
    writeFileSync(path.join(userData, 'logs', 'brainstrike.log'), 'kept');
    return { pgdata, root: rootPath };
  }

  it('preserves the live reset namespace and every ancestor through the packaged userData purge', async () => {
    const { pgdata, root } = seedPackagedProfile();
    const profile = path.dirname(pgdata);
    const sessionData = path.join(userData, 'session-data');
    mkdirSync(sessionData);
    writeFileSync(path.join(sessionData, 'engine-container'), 'Electron-owned container');
    writeFileSync(path.join(profile, 'state.db'), 'state');
    writeFileSync(path.join(profile, 'index.db-wal'), 'index');
    const lease = await acquireProfileResetLease(profile);
    try {
      const result = await resetDesktopApplicationData({
        getProtectedPaths: () => [RootLock.dirOf(lease.root), sessionData],
        resetDatabaseProfile: async () => {
          await lease.clearRootContents();
          expect(existsSync(path.join(profile, 'state.db'))).toBe(false);
          expect(existsSync(path.join(profile, 'index.db-wal'))).toBe(false);
          expect(existsSync(path.join(userData, 'Local Storage'))).toBe(true);
        },
        stopBackgroundRuntimes: async () => undefined,
        userDataPath: userData,
      });
      expect(existsSync(root)).toBe(true);
      expect(existsSync(RootLock.dirOf(lease.root))).toBe(true);
      expect(existsSync(path.join(root, 'backups'))).toBe(false);
      expect(existsSync(path.join(userData, 'Local Storage'))).toBe(false);
      expect(existsSync(path.join(sessionData, 'engine-container'))).toBe(true);
      expect(result.preservedPaths).toContain(RootLock.dirOf(lease.root));
      await expect(RootLock.acquire(profile)).rejects.toMatchObject({ name: 'RootLockedError' });
    } finally {
      lease.release();
    }
    const next = await RootLock.acquire(profile);
    next.release();
  });

  it('closes and resets the database before any userData entry is staged, then wipes the data root but keeps logs', async () => {
    const { pgdata, root } = seedPackagedProfile();
    const observedAtDatabaseReset: { localStorage: boolean; pgdata: boolean }[] = [];

    await resetDesktopApplicationData({
      resetDatabaseProfile: async () => {
        // Runs after the DB host is closed (db-main's resetLocalDatabase) and
        // before ANY userData staging: everything else must still be present.
        observedAtDatabaseReset.push({
          localStorage: existsSync(path.join(userData, 'Local Storage')),
          pgdata: existsSync(pgdata),
        });
      },
      stopBackgroundRuntimes: async () => undefined,
      userDataPath: userData,
    });

    expect(observedAtDatabaseReset).toEqual([{ localStorage: true, pgdata: true }]);
    expect(root).toBe(path.join(userData, 'data'));
    expect(existsSync(root)).toBe(false);
    expect(existsSync(path.join(userData, 'Local Storage'))).toBe(false);
    expect(existsSync(path.join(userData, 'logs', 'brainstrike.log'))).toBe(true);
    expect(existsSync(userData)).toBe(true);
  });
});
