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
});
