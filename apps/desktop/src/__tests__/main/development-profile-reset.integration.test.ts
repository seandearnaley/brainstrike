// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireProfileResetLease } from '@brainstrike/host-lease';
import { expect, it } from 'vitest';
import { joinProfileDirectory, resolveDevelopmentUserDataPath } from '../../database-location';
import { resetDesktopApplicationData } from '../../desktop-factory-reset';

it('clears the selected development profile without deleting live Session containers or another profile', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'brainstrike-development-reset-'));
  const location = { profile: 'incident-a', rootPath, source: 'development' as const };
  const databaseRoot = joinProfileDirectory(rootPath, location.profile);
  const userDataPath = resolveDevelopmentUserDataPath(location);
  const otherUserData = resolveDevelopmentUserDataPath({ ...location, profile: 'incident-b' });
  const sessionData = join(userDataPath, 'session-data');
  await mkdir(databaseRoot, { recursive: true });
  await mkdir(sessionData, { recursive: true });
  await mkdir(otherUserData, { recursive: true });
  await writeFile(join(databaseRoot, 'current-database'), 'database');
  await writeFile(join(userDataPath, 'electron-storage.json'), 'selected grants');
  await writeFile(join(sessionData, 'engine-container'), 'Chromium-owned container');
  await writeFile(join(otherUserData, 'electron-storage.json'), 'other profile grants');
  const lease = await acquireProfileResetLease(databaseRoot);
  try {
    await resetDesktopApplicationData({
      getProtectedPaths: () => [join(databaseRoot, 'lock'), sessionData],
      resetDatabaseProfile: async () => {
        await lease.clearRootContents();
        // The DB owner must not remove state owned by Electron's Session API.
        expect(await readFile(join(sessionData, 'engine-container'), 'utf8')).toBe(
          'Chromium-owned container'
        );
        expect(await readFile(join(userDataPath, 'electron-storage.json'), 'utf8')).toBe(
          'selected grants'
        );
      },
      stopBackgroundRuntimes: async () => undefined,
      userDataPath,
    });
    expect(await readdir(databaseRoot)).toEqual(['lock']);
    expect(await readdir(userDataPath)).toEqual(['session-data']);
    expect(await readFile(join(sessionData, 'engine-container'), 'utf8')).toBe(
      'Chromium-owned container'
    );
    expect(await readFile(join(otherUserData, 'electron-storage.json'), 'utf8')).toBe(
      'other profile grants'
    );
  } finally {
    lease.release();
    await rm(rootPath, { force: true, recursive: true });
  }
});
