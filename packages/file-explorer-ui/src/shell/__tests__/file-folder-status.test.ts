/**
 * A file tab's folder that is not open: it is opening only while a request for its own folder is
 * in flight (or start-up restore has not answered), and otherwise closed, with the folder to
 * reopen and the reason its last reopen failed.
 */
import { describe, expect, it } from 'vitest';
import { unopenedFileFolderStatus } from '../file-folder-status.ts';

const recents = [
  { displayName: 'beaker', lastGrantedAt: 1, path: '/Users/sean/code/beaker' },
  { displayName: 'code', lastGrantedAt: 1, path: '/Users/sean/code' },
];
const idle = { failures: new Map<string, string>(), opening: new Map<string, number>() };
const file = '/Users/sean/code/beaker/playwright.live.config.ts';
const none: ReadonlySet<string> = new Set();

describe('a file whose folder is not open', () => {
  it('is closed, naming the innermost Recents folder to reopen', () => {
    expect(
      unopenedFileFolderStatus({
        filePath: file,
        openPaths: none,
        recents,
        requests: idle,
        restorePending: false,
      })
    ).toEqual({ failure: null, kind: 'closed', name: 'beaker', path: '/Users/sean/code/beaker' });
  });

  it("stays closed while another folder opens, and opens only with its own folder's request", () => {
    const otherOpening = { ...idle, opening: new Map([['/Users/sean/worktrees/sunny-ivy', 1]]) };
    expect(
      unopenedFileFolderStatus({
        filePath: file,
        openPaths: none,
        recents,
        requests: otherOpening,
        restorePending: false,
      }).kind
    ).toBe('closed');
    const ownOpening = { ...idle, opening: new Map([['/Users/sean/code/beaker', 1]]) };
    expect(
      unopenedFileFolderStatus({
        filePath: file,
        openPaths: none,
        recents,
        requests: ownOpening,
        restorePending: false,
      })
    ).toEqual({ kind: 'opening', name: 'beaker' });
  });

  it('is opening while start-up restore has not answered', () => {
    expect(
      unopenedFileFolderStatus({
        filePath: file,
        openPaths: none,
        recents,
        requests: idle,
        restorePending: true,
      })
    ).toEqual({ kind: 'opening', name: 'beaker' });
  });

  it("carries why its folder's last reopen failed, for a folder outside Recents too", () => {
    const worktreeFile = '/Users/sean/worktrees/sunny-ivy/src/index.ts';
    const failed = {
      ...idle,
      failures: new Map([['/Users/sean/worktrees/sunny-ivy', 'The folder no longer exists.']]),
    };
    expect(
      unopenedFileFolderStatus({
        filePath: worktreeFile,
        openPaths: none,
        recents,
        requests: failed,
        restorePending: false,
      })
    ).toEqual({
      failure: 'The folder no longer exists.',
      kind: 'closed',
      name: 'sunny-ivy',
      path: '/Users/sean/worktrees/sunny-ivy',
    });
  });

  it('has no folder to reopen when no known folder contains it', () => {
    expect(
      unopenedFileFolderStatus({
        filePath: '/elsewhere/a.ts',
        openPaths: none,
        recents,
        requests: idle,
        restorePending: false,
      })
    ).toEqual({ failure: null, kind: 'closed', name: null, path: null });
  });
  it('offers the outer folder once the nested one is open under another folder', () => {
    expect(
      unopenedFileFolderStatus({
        filePath: file,
        openPaths: new Set(['/Users/sean/code/beaker']),
        recents,
        requests: idle,
        restorePending: false,
      })
    ).toEqual({ failure: null, kind: 'closed', name: 'code', path: '/Users/sean/code' });
  });
});
