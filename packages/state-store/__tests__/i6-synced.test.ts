// M0-A2 item 6 (spike test/i6-synced.test.ts): refuse data roots inside sync-provider folders (path rules). Nothing is
// created under the real home.
import { mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { assertNotSyncedRoot, SyncedRootError } from '../src/sync-roots.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(() => cleanupDirs());

const refuses = (
  root: string,
  provider: RegExp,
  env?: Parameters<typeof assertNotSyncedRoot>[1]
): void => {
  let err: unknown = null;
  try {
    assertNotSyncedRoot(root, env);
  } catch (e) {
    err = e;
  }
  expect(err, `${root} should be refused`).toBeInstanceOf(SyncedRootError);
  expect((err as SyncedRootError).provider).toMatch(provider);
  expect((err as Error).message).toMatch(/choose a local folder/);
};

describe('item 6 · synced data roots', () => {
  const home = homedir();
  test('macOS: iCloud Drive and File Provider (CloudStorage) paths are refused, with the provider named', () => {
    refuses(
      join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Brainstrike'),
      /iCloud Drive/,
      { platform: 'darwin' }
    );
    refuses(join(home, 'Library', 'CloudStorage', 'OneDrive-Personal', 'bs'), /File Provider/, {
      platform: 'darwin',
    });
    refuses(join(home, 'Library', 'CloudStorage', 'Dropbox', 'bs'), /File Provider/, {
      platform: 'darwin',
    });
    refuses(
      join(home, 'Library', 'CloudStorage', 'GoogleDrive-me@example.com', 'My Drive', 'bs'),
      /File Provider/,
      { platform: 'darwin' }
    );
    refuses(join(home, 'library', 'mobile documents', 'x'), /iCloud Drive/, { platform: 'darwin' }); // APFS is case-insensitive by default
  });

  test('Dropbox and OneDrive folders in the home are refused (macOS and Linux)', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      refuses(join(home, 'Dropbox', 'bs'), /Dropbox/, { platform });
      refuses(join(home, 'Dropbox (Acme Corp)', 'bs'), /Dropbox/, { platform });
      refuses(join(home, 'OneDrive', 'bs'), /OneDrive/, { platform });
      refuses(join(home, 'OneDrive - Acme Corp', 'bs'), /OneDrive/, { platform });
    }
  });

  test.skipIf(process.platform === 'win32')(
    'a symlink into a synced folder is resolved and refused (POSIX path rules)',
    () => {
      const fakeHome = freshDir('i6home');
      const cloud = join(fakeHome, 'Library', 'CloudStorage', 'OneDrive-Personal');
      mkdirSync(cloud, { recursive: true });
      const link = join(freshDir('i6link'), 'data');
      symlinkSync(cloud, link);
      refuses(join(link, 'brainstrike'), /File Provider/, { home: fakeHome, platform: 'darwin' });
    }
  );

  test('local folders are accepted', () => {
    expect(() =>
      assertNotSyncedRoot(join(home, 'Library', 'Application Support', 'Brainstrike'), {
        platform: 'darwin',
      })
    ).not.toThrow();
    expect(() =>
      assertNotSyncedRoot(join(home, 'DropboxNotes', 'bs'), { platform: 'darwin' })
    ).not.toThrow();
    expect(() => assertNotSyncedRoot(freshDir('i6local'))).not.toThrow();
  });

  test('Windows: OneDrive env roots, which cover Known Folder Move redirects (path rule, runs on every OS)', () => {
    const env = {
      OneDrive: 'C:\\Users\\sean\\OneDrive',
      OneDriveCommercial: 'D:\\Corp\\OneDrive - Acme',
      USERPROFILE: 'C:\\Users\\sean',
    };
    refuses('C:\\Users\\sean\\OneDrive\\Documents\\Brainstrike', /OneDrive/, {
      env,
      platform: 'win32',
    });
    refuses('c:\\users\\sean\\onedrive\\desktop\\bs', /OneDrive/, { env, platform: 'win32' });
    refuses('D:\\Corp\\OneDrive - Acme\\Documents\\bs', /OneDriveCommercial/, {
      env,
      platform: 'win32',
    });
    refuses('C:\\Users\\sean\\OneDrive - Acme\\bs', /OneDrive/, {
      env: { USERPROFILE: 'C:\\Users\\sean' },
      platform: 'win32',
    });
    refuses('C:\\Users\\sean\\Dropbox\\bs', /Dropbox/, {
      env: { USERPROFILE: 'C:\\Users\\sean' },
      platform: 'win32',
    });
    expect(() =>
      assertNotSyncedRoot('C:\\Users\\sean\\AppData\\Roaming\\Brainstrike', {
        env,
        platform: 'win32',
      })
    ).not.toThrow();
  });
});

describe('item 6 · StateStore.open refuses a synced root', () => {
  test.skipIf(process.platform !== 'darwin')(
    'the refusal happens before anything is created (macOS iCloud path)',
    async () => {
      const fakeHome = freshDir('i6open');
      const root = join(fakeHome, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'bs');
      await expect(StateStore.open(root, { home: fakeHome })).rejects.toThrow(SyncedRootError);
      expect(readdirSync(fakeHome)).toEqual([]);
    }
  );

  test('the refusal happens before anything is created (Dropbox in the home)', async () => {
    const fakeHome = freshDir('i6open2');
    const root = join(fakeHome, 'Dropbox', 'bs');
    await expect(StateStore.open(root, { home: fakeHome })).rejects.toThrow(SyncedRootError);
    expect(readdirSync(fakeHome)).toEqual([]);
  });
});
