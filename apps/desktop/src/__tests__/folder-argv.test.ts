import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFolderCandidatesFromArgv } from '../folder-argv';

const CWD = path.resolve('/work');
// Packaged appPath points inside the bundle; no packaged argv positional can
// legitimately equal it, and the packaged branch must never consult it anyway.
const PACKAGED_APP_PATH = '/Applications/BrainStrike.app/Contents/Resources/app.asar';
const DEV_APP_PATH = path.resolve('/repo/apps/desktop');

describe('resolveFolderCandidatesFromArgv', () => {
  it('takes a single positional path from a PACKAGED launch', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: PACKAGED_APP_PATH,
        argv: ['/Applications/BrainStrike.app/Contents/MacOS/BrainStrike', '/work/repo'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('skips the app-path argument on an UNPACKAGED launch by IDENTITY, not position', () => {
    // `electron .` passes the app directory as a positional. Treating it as a
    // folder would mount the repo on every dev launch — the falsifier for a
    // naive "everything after argv[0]" parse. The skip must match the VALUE
    // (resolved against appPath), not an argv index — see the reordered
    // second-instance shape below.
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: DEV_APP_PATH,
        argv: ['/node_modules/electron/dist/electron', '/repo/apps/desktop', '/work/repo'],
        isPackaged: false,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('drops the app path from Chromium-REORDERED second-instance argv (BST-1393 L5)', () => {
    // Captured live 2026-08-27 (Electron 43.4.0, macOS, minimal
    // single-instance-lock repro): the second instance was launched as
    //   electron . --no-sandbox --brainstrike-desktop-launch-mode=dev-server <stranger-dir>
    // but the argv DELIVERED to the first instance's `second-instance` handler
    // was regrouped by Chromium as [program, ...switches, ...positionals],
    // with Chromium's own injected switches included:
    //   [ .../electron/dist/Electron.app/Contents/MacOS/Electron,
    //     --no-sandbox,
    //     --brainstrike-desktop-launch-mode=dev-server,
    //     --allow-file-access-from-files,
    //     --enable-avfoundation,
    //     .,
    //     <stranger-dir> ]
    // The `.` app-path positional landed at index 5 — past any fixed-index
    // skip — and resolves against workingDirectory (the app dir) to the repo
    // checkout. Only the stranger dir is a real candidate.
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: DEV_APP_PATH,
        argv: [
          '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
          '--no-sandbox',
          '--brainstrike-desktop-launch-mode=dev-server',
          '--allow-file-access-from-files',
          '--enable-avfoundation',
          '.',
          '/tmp/stranger-dir',
        ],
        isPackaged: false,
        // The second instance was launched from the app directory, so `.`
        // resolves exactly to appPath.
        workingDirectory: DEV_APP_PATH,
      })
    ).toEqual([path.resolve('/tmp/stranger-dir')]);
  });

  it('drops every spelling that RESOLVES to the app path on an UNPACKAGED launch', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: DEV_APP_PATH,
        argv: [
          '/node_modules/electron/dist/electron',
          '.',
          '/repo/apps/desktop',
          '/repo/apps/desktop/',
          '../desktop',
        ],
        isPackaged: false,
        workingDirectory: DEV_APP_PATH,
      })
    ).toEqual([]);
  });

  it('emits nothing for the plain first-launch dev shape `electron .`', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: DEV_APP_PATH,
        argv: ['/node_modules/electron/dist/electron', '.'],
        isPackaged: false,
        workingDirectory: DEV_APP_PATH,
      })
    ).toEqual([]);
  });

  it('keeps a PACKAGED positional even when it equals appPath — packaged behavior is unchanged', () => {
    // The identity skip exists only to recognize the `electron <app-dir>`
    // launch convention, which packaged argv does not have. A packaged user
    // naming the bundle-internal path is pathological but still a REQUEST;
    // the stat filter and mount gates downstream decide its fate.
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: PACKAGED_APP_PATH,
        argv: ['/Applications/BrainStrike.app/Contents/MacOS/BrainStrike', PACKAGED_APP_PATH],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve(PACKAGED_APP_PATH)]);
  });

  it('case-folds the app-path identity skip on win32 only', () => {
    const params = {
      appPath: DEV_APP_PATH,
      argv: ['/node_modules/electron/dist/electron', '/repo/Apps/Desktop'],
      isPackaged: false,
      workingDirectory: DEV_APP_PATH,
    } as const;
    // win32 paths are case-insensitive: a differently-cased spelling IS the
    // app path and must be skipped.
    expect(resolveFolderCandidatesFromArgv({ ...params, platform: 'win32' })).toEqual([]);
    // On a case-sensitive platform the same spelling names a DIFFERENT
    // directory and stays a candidate.
    expect(resolveFolderCandidatesFromArgv({ ...params, platform: 'linux' })).toEqual([
      path.resolve('/repo/Apps/Desktop'),
    ]);
  });

  it('resolves a relative path against the working directory', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: PACKAGED_APP_PATH,
        argv: ['/app/BrainStrike', '.'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([CWD]);
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: PACKAGED_APP_PATH,
        argv: ['/app/BrainStrike', 'repo'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('ignores every switch, including Chromium and BrainStrike ones', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: PACKAGED_APP_PATH,
        argv: [
          '/app/BrainStrike',
          '--brainstrike-desktop-launch-mode=built',
          '--inspect=9222',
          '-v',
          '--',
          '/work/repo',
        ],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('dedupes paths that differ only by trailing separator', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: PACKAGED_APP_PATH,
        argv: ['/app/BrainStrike', '/work/repo', '/work/repo/'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('returns nothing for a bare launch', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: PACKAGED_APP_PATH,
        argv: ['/app/BrainStrike'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([]);
  });

  it('never emits an empty or whitespace-only candidate', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: PACKAGED_APP_PATH,
        argv: ['/app/BrainStrike', '', '   '],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([]);
  });

  it('preserves whitespace at the edges of a legitimate path instead of trimming it away', () => {
    // A quoted CLI argument can legally name a directory whose name begins or
    // ends with whitespace. `trim()` is used only to DETECT whitespace-only
    // arguments (the case above) — it must never be applied to the value that
    // gets resolved, or this would silently corrupt the path (reject it as
    // nonexistent, or resolve to a different, existing folder instead).
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: PACKAGED_APP_PATH,
        argv: ['/app/BrainStrike', 'repo with trailing space '],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve(CWD, 'repo with trailing space ')]);
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: PACKAGED_APP_PATH,
        argv: ['/app/BrainStrike', ' repo-with-leading-space'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve(CWD, ' repo-with-leading-space')]);
  });

  it('case-folds the dedupe key on win32 only, exercised via the threaded `platform` param', () => {
    // `process.platform` is never read directly for this decision — `platform`
    // defaults to it but is threaded through `FolderArgvParams` explicitly, so
    // this branch is reachable from any CI runner rather than shipping
    // untested outside a real Windows box.
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: PACKAGED_APP_PATH,
        argv: ['/app/BrainStrike', '/work/Repo', '/work/repo'],
        isPackaged: true,
        platform: 'win32',
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/Repo')]);

    // The SAME two inputs stay two distinct candidates on a case-sensitive
    // platform — proves the branch is actually conditional, not always folding.
    expect(
      resolveFolderCandidatesFromArgv({
        appPath: PACKAGED_APP_PATH,
        argv: ['/app/BrainStrike', '/work/Repo', '/work/repo'],
        isPackaged: true,
        platform: 'linux',
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/Repo'), path.resolve('/work/repo')]);
  });
});
