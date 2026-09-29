import { GIT_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/git-panel/availability';
import { describe, expect, it } from 'vitest';
import { gitContract } from '../../ipc-domains/git.contract';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

describe('git IPC contract', () => {
  it('derives the exact renderer bridge key set from the contract', () => {
    expect(Object.keys(gitContract).sort()).toEqual([...GIT_BRIDGE_REQUIRED_METHODS].sort());
  });

  it('binds every method to the manifest as a raw visible-UI channel', () => {
    for (const [method, spec] of Object.entries(gitContract)) {
      expect(spec).toMatchObject({
        channel: DESKTOP_IPC_CHANNELS.git[method as keyof typeof DESKTOP_IPC_CHANNELS.git],
        envelope: 'raw',
        roles: ['visible-ui'],
      });
    }
  });

  it('parses required and optional arguments before handlers run', () => {
    expect(gitContract.status.parseArgs(['root-1'])).toEqual(['root-1']);
    expect(gitContract.diff.parseArgs(['root-1', { mode: 'working' }])).toEqual([
      'root-1',
      { mode: 'working' },
    ]);
    expect(gitContract.push.parseArgs(['root-1'])).toEqual(['root-1', {}]);
    expect(gitContract.push.parseArgs(['root-1', undefined])).toEqual(['root-1', {}]);
    expect(gitContract.stage.parseArgs(['root-1', undefined])).toEqual(['root-1', {}]);
    expect(gitContract.unstage.parseArgs(['root-1', undefined])).toEqual(['root-1', {}]);
    expect(gitContract.stage.parseArgs(['root-1', { path: 'src/index.ts' }])).toEqual([
      'root-1',
      { path: 'src/index.ts' },
    ]);
  });

  it('round-trips every supported parameter key', () => {
    expect(
      gitContract.commit.parseArgs(['root-1', { description: 'More detail', summary: 'Summary' }])
    ).toEqual(['root-1', { description: 'More detail', summary: 'Summary' }]);
    expect(gitContract.commitFiles.parseArgs(['root-1', { commit: 'abc123' }])).toEqual([
      'root-1',
      { commit: 'abc123' },
    ]);
    expect(
      gitContract.createBranch.parseArgs(['root-1', { branch: 'next', startPoint: 'main' }])
    ).toEqual(['root-1', { branch: 'next', startPoint: 'main' }]);
    expect(
      gitContract.diff.parseArgs(['root-1', { mode: 'working', path: 'src/index.ts' }])
    ).toEqual(['root-1', { mode: 'working', path: 'src/index.ts' }]);
    expect(gitContract.fetch.parseArgs(['root-1', { remote: 'origin' }])).toEqual([
      'root-1',
      { remote: 'origin' },
    ]);
    expect(
      gitContract.history.parseArgs(['root-1', { limit: 20, offset: 0, ref: 'main' }])
    ).toEqual(['root-1', { limit: 20, offset: 0, ref: 'main' }]);
    expect(gitContract.push.parseArgs(['root-1', { remote: 'origin' }])).toEqual([
      'root-1',
      { remote: 'origin' },
    ]);
    expect(gitContract.stage.parseArgs(['root-1', { path: 'src/index.ts' }])).toEqual([
      'root-1',
      { path: 'src/index.ts' },
    ]);
    expect(
      gitContract.structuredFileDiff.parseArgs([
        'root-1',
        { commitId: 'abc123', mode: 'commit', path: 'src/index.ts' },
      ])
    ).toEqual(['root-1', { commitId: 'abc123', mode: 'commit', path: 'src/index.ts' }]);
    expect(
      gitContract.structuredFileDiff.parseArgs([
        'root-1',
        { baseRef: 'main', mode: 'range', path: 'src/index.ts' },
      ])
    ).toEqual(['root-1', { baseRef: 'main', mode: 'range', path: 'src/index.ts' }]);
    expect(gitContract.switchBranch.parseArgs(['root-1', { branch: 'main' }])).toEqual([
      'root-1',
      { branch: 'main' },
    ]);
    expect(gitContract.unstage.parseArgs(['root-1', { path: 'src/index.ts' }])).toEqual([
      'root-1',
      { path: 'src/index.ts' },
    ]);
  });

  it('rejects malformed renderer input instead of passing it to a handler', () => {
    expect(() => gitContract.status.parseArgs([42])).toThrow('git status requires a string rootId');
    expect(() => gitContract.diff.parseArgs(['root-1', null])).toThrow(
      'git diff requires a params object'
    );
    expect(() => gitContract.diff.parseArgs(['root-1', { mode: 'untracked' }])).toThrow(
      'git diff untracked mode requires a string path'
    );
    expect(() => gitContract.commit.parseArgs(['root-1', { summary: 42 }])).toThrow(
      'git commit summary must be a string'
    );
    expect(() => gitContract.history.parseArgs(['root-1', { limit: 10, offset: '0' }])).toThrow(
      'git history offset must be a number'
    );
    expect(() =>
      gitContract.structuredFileDiff.parseArgs(['root-1', { mode: 'range', path: 'src/index.ts' }])
    ).toThrow('git structuredFileDiff range mode baseRef must be a string');
    expect(() => gitContract.push.parseArgs(['root-1', { extra: true, remote: 'origin' }])).toThrow(
      'git push received unsupported params: extra'
    );
    expect(() => gitContract.status.parseArgs([])).toThrow(
      'git status requires exactly 1 argument'
    );
    expect(() => gitContract.push.parseArgs(['root-1', {}, {}])).toThrow(
      'git push requires one or two arguments'
    );
    expect(() => gitContract.stage.parseArgs(['root-1', 'src/index.ts'])).toThrow(
      'git stage requires a params object'
    );
    expect(() => gitContract.diff.parseArgs(['root-1', { mode: 'bogus' }])).toThrow(
      'git diff mode must be "working", "staged", or "untracked"'
    );
    expect(() => gitContract.structuredFileDiff.parseArgs(['root-1', { mode: 'bogus' }])).toThrow(
      'git structuredFileDiff mode must be "commit", "range", "staged", "untracked", "unstaged", or "working"'
    );
  });
});
