// Refuse a data root inside a file-sync provider's folder (M0-A2 src/sync-roots.ts, item 6). Sync clients copy -wal/-shm
// independently, make conflict copies and evict files: the single-writer assumptions break there. Path rules only:
// macOS iCloud Drive and File Provider (CloudStorage), Dropbox, OneDrive; Windows OneDrive roots via the OneDrive*
// environment variables, which also cover Known Folder Move (Desktop/Documents redirected into OneDrive).
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export class SyncedRootError extends Error {
  readonly provider: string;

  constructor(root: string, provider: string, under: string) {
    super(
      `refusing data root ${root}: it is inside ${provider} (${under}). Synced folders corrupt live databases and append logs; choose a local folder.`
    );
    this.name = 'SyncedRootError';
    this.provider = provider;
  }
}

export interface SyncEnv {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
}

/** Realpath of the nearest existing ancestor, plus the not-yet-existing tail (POSIX). */
function resolveReal(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realpathSync(cur), ...tail);
}

export function assertNotSyncedRoot(root: string, e: SyncEnv = {}): void {
  const platform = e.platform ?? process.platform;
  const env = e.env ?? process.env;
  if (platform === 'win32') {
    assertWin(root, e.home ?? env['USERPROFILE'] ?? '', env);
    return;
  }
  const home = e.home ? resolveReal(e.home) : homedir();
  const real = resolveReal(root);
  const fold =
    platform === 'darwin' ? (s: string): string => s.toLowerCase() : (s: string): string => s;
  const under = (base: string): boolean => {
    const b = fold(base);
    const r = fold(real);
    return r === b || r.startsWith(b + path.sep);
  };
  if (platform === 'darwin') {
    const icloud = path.join(home, 'Library', 'Mobile Documents');
    if (under(icloud)) {
      throw new SyncedRootError(root, 'iCloud Drive', icloud);
    }
    const cs = path.join(home, 'Library', 'CloudStorage');
    if (under(cs)) {
      throw new SyncedRootError(
        root,
        'a File Provider sync folder (OneDrive, Dropbox, Google Drive, Box…)',
        cs
      );
    }
  }
  if (!under(home)) {
    return;
  }
  const first = path.relative(home, real).split(path.sep)[0] ?? '';
  if (/^dropbox( \(.+\))?$/i.test(first)) {
    throw new SyncedRootError(root, 'Dropbox', path.join(home, first));
  }
  if (/^onedrive( - .+)?$/i.test(first)) {
    throw new SyncedRootError(root, 'OneDrive', path.join(home, first));
  }
}

function assertWin(
  root: string,
  userProfile: string,
  env: Readonly<Record<string, string | undefined>>
): void {
  const w = path.win32;
  const real = w.resolve(root).toLowerCase();
  const under = (base: string): boolean => {
    const b = w.resolve(base).toLowerCase();
    return real === b || real.startsWith(`${b}\\`);
  };
  for (const k of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    const v = env[k];
    if (v && under(v)) {
      throw new SyncedRootError(root, `OneDrive (%${k}%; includes Known Folder Move redirects)`, v);
    }
  }
  if (userProfile && under(userProfile)) {
    const first = w.relative(w.resolve(userProfile), w.resolve(root)).split('\\')[0] ?? '';
    if (/^onedrive( - .+)?$/i.test(first)) {
      throw new SyncedRootError(root, 'OneDrive', w.join(userProfile, first));
    }
    if (/^dropbox( \(.+\))?$/i.test(first)) {
      throw new SyncedRootError(root, 'Dropbox', w.join(userProfile, first));
    }
  }
}
