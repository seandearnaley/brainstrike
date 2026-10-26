/** A turn's workspace snapshot sits before its first model request and its run's end. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  execFileSnapshotGitRunner,
  type SnapshotGitCommandRunner,
} from '../../assistant-server/snapshot-git';
import { createSnapshotService } from '../../assistant-server/snapshot-service';

let base: string;
let root: string;
let gitArgs: string[][];

const countingRunner: SnapshotGitCommandRunner = async (params) => {
  gitArgs.push([...params.args]);
  return await execFileSnapshotGitRunner(params);
};

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'bs-snapshot-processes-'));
  root = path.join(base, 'root');
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'notes.txt'), 'first\n');
  gitArgs = [];
});

afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

describe('workspace snapshot git processes', () => {
  it('takes a new root’s first snapshot and each later one in a handful of git processes', async () => {
    const service = createSnapshotService({
      runner: countingRunner,
      snapshotsBaseDir: path.join(base, 'snapshots'),
    });
    const handle = await service.ensureShadowRepo({ path: root, rootId: 'root-1' });
    const first = await service.snapshot(handle, {
      kind: 'turn-start',
      runId: 'run-1',
      threadId: 'thread-1',
    });
    // init, the runner probe and the snapshot itself, each operation under one hook probe.
    expect(gitArgs).toHaveLength(9);

    gitArgs = [];
    await writeFile(path.join(root, 'notes.txt'), 'second\n');
    const second = await service.snapshot(handle, {
      kind: 'turn-end',
      runId: 'run-1',
      threadId: 'thread-1',
    });
    expect(gitArgs).toHaveLength(6);
    // Every command but the probe still runs with hooks and fsmonitor off.
    for (const args of gitArgs.filter((command) => !command.includes('--get-regexp'))) {
      expect(args).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null']));
      expect(args).toEqual(expect.arrayContaining(['core.fsmonitor=false']));
    }

    // The shadow repo keeps its pinned config and a lineage of both snapshots.
    const shadow = (...args: string[]): string =>
      execFileSync('git', [`--git-dir=${handle.gitDir}`, ...args], { encoding: 'utf8' }).trim();
    expect(shadow('config', '--get', 'core.filemode')).toBe('false');
    expect(shadow('config', '--get', 'core.autocrlf')).toBe('false');
    expect(shadow('config', '--get', 'commit.gpgsign')).toBe('false');
    expect(shadow('log', '--format=%an <%ae>', '-1', second.commitOid)).toBe(
      'BrainStrike Snapshots <snapshots@brainstrike.local>'
    );
    expect(shadow('rev-parse', `${second.commitOid}^`)).toBe(first.commitOid);
    expect(shadow('show', `${second.commitOid}:notes.txt`)).toBe('second');
  });
});
