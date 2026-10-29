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
  expect((err as Error).message).toMatch(/choose a local folder/u);
};

describe('item 6 · synced data roots', () => {
  const home = homedir();
  test('macOS: iCloud Drive and File Provider (CloudStorage) paths are refused, with the provider named', () => {
    refuses(
      join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Brainstrike'),
      /iCloud Drive/u,
      { platform: 'darwin' }
    );
    refuses(join(home, 'Library', 'CloudStorage', 'OneDrive-Personal', 'bs'), /File Provider/u, {
      platform: 'darwin',
    });
    refuses(join(home, 'Library', 'CloudStorage', 'Dropbox', 'bs'), /File Provider/u, {
      platform: 'darwin',
    });
    refuses(
      join(home, 'Library', 'CloudStorage', 'GoogleDrive-me@example.com', 'My Drive', 'bs'),
      /File Provider/u,
      { platform: 'darwin' }
    );
    refuses(join(home, 'library', 'mobile documents', 'x'), /iCloud Drive/u, {
      platform: 'darwin',
    }); // APFS is case-insensitive by default
  });

  test('Dropbox and OneDrive folders in the home are refused (macOS and Linux)', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      refuses(join(home, 'Dropbox', 'bs'), /Dropbox/u, { platform });
      refuses(join(home, 'Dropbox (Acme Corp)', 'bs'), /Dropbox/u, { platform });
      refuses(join(home, 'OneDrive', 'bs'), /OneDrive/u, { platform });
      refuses(join(home, 'OneDrive - Acme Corp', 'bs'), /OneDrive/u, { platform });
    }
  });

  // This OS's own rules: a home Dropbox folder is refused on every OS, and the link is a symlink on POSIX and a
  // junction on Windows (`symlink` ignores the type elsewhere).
  test('a link into a synced folder is resolved and refused, even before the root exists', () => {
    const fakeHome = freshDir('i6home');
    const dropbox = join(fakeHome, 'Dropbox');
    mkdirSync(dropbox);
    const link = join(freshDir('i6link'), 'data');
    symlinkSync(dropbox, link, 'junction');
    refuses(join(link, 'brainstrike'), /Dropbox/u, { env: {}, home: fakeHome });
  });

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
    refuses('C:\\Users\\sean\\OneDrive\\Documents\\Brainstrike', /OneDrive/u, {
      env,
      platform: 'win32',
    });
    refuses('c:\\users\\sean\\onedrive\\desktop\\bs', /OneDrive/u, { env, platform: 'win32' });
    refuses('D:\\Corp\\OneDrive - Acme\\Documents\\bs', /OneDriveCommercial/u, {
      env,
      platform: 'win32',
    });
    refuses('C:\\Users\\sean\\OneDrive - Acme\\bs', /OneDrive/u, {
      env: { USERPROFILE: 'C:\\Users\\sean' },
      platform: 'win32',
    });
    refuses('C:\\Users\\sean\\Dropbox\\bs', /Dropbox/u, {
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
  test('the refusal happens before anything is created (Dropbox in the home)', async () => {
    const fakeHome = freshDir('i6open2');
    const root = join(fakeHome, 'Dropbox', 'bs');
    await expect(StateStore.open(root, { home: fakeHome })).rejects.toThrow(SyncedRootError);
    expect(readdirSync(fakeHome)).toEqual([]);
  });
});
