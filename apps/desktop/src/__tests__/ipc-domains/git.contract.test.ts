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
  });
});
