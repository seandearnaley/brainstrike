import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFolderCandidatesFromArgv } from '../folder-argv';

const CWD = path.resolve('/work');

describe('resolveFolderCandidatesFromArgv', () => {
  it('takes a single positional path from a PACKAGED launch', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        argv: ['/Applications/BrainStrike.app/Contents/MacOS/BrainStrike', '/work/repo'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('skips the app-path argument on an UNPACKAGED launch', () => {
    // `electron .` puts the app directory at argv[1]. Treating it as a folder
    // would mount the repo on every dev launch — the falsifier for a naive
    // "everything after argv[0]" parse.
    expect(
      resolveFolderCandidatesFromArgv({
        argv: ['/node_modules/electron/dist/electron', '/repo/apps/desktop', '/work/repo'],
        isPackaged: false,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('resolves a relative path against the working directory', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        argv: ['/app/BrainStrike', '.'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([CWD]);
    expect(
      resolveFolderCandidatesFromArgv({
        argv: ['/app/BrainStrike', 'repo'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('ignores every switch, including Chromium and BrainStrike ones', () => {
    expect(
      resolveFolderCandidatesFromArgv({
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
        argv: ['/app/BrainStrike', '/work/repo', '/work/repo/'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/repo')]);
  });

  it('returns nothing for a bare launch', () => {
    expect(
      resolveFolderCandidatesFromArgv({
        argv: ['/app/BrainStrike'],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([]);
  });

  it('never emits an empty or whitespace-only candidate', () => {
    expect(
      resolveFolderCandidatesFromArgv({
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
        argv: ['/app/BrainStrike', 'repo with trailing space '],
        isPackaged: true,
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve(CWD, 'repo with trailing space ')]);
    expect(
      resolveFolderCandidatesFromArgv({
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
        argv: ['/app/BrainStrike', '/work/Repo', '/work/repo'],
        isPackaged: true,
        platform: 'linux',
        workingDirectory: CWD,
      })
    ).toEqual([path.resolve('/work/Repo'), path.resolve('/work/repo')]);
  });
});
