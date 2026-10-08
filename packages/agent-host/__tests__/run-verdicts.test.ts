import { describe, expect, it } from 'vitest';
import type { HostLogRow } from '../src/protocol.js';
import { projectRunVerdicts } from '../src/run-verdicts.js';

type Source = 'edit_revert' | 'hook' | 'user';
type Verdict = 'failed' | 'mixed' | 'succeeded';

function verdict(seq: number, source: Source, value: Verdict, runId = 'run-1'): HostLogRow {
  return {
    event: { runId, source, type: 'run.verdict', verdict: value },
    seq,
    threadId: 'thread-1',
    ts: 1_791_458_400_000 + seq,
  };
}

describe('projectRunVerdicts', () => {
  it.each([
    ['a later user verdict replaces an earlier user verdict', ['user', 'user'], 2],
    ['a user verdict replaces a hook verdict', ['hook', 'user'], 2],
    ['a hook verdict never replaces a user verdict', ['user', 'hook'], 1],
    ['a revert verdict never replaces a user verdict', ['user', 'edit_revert'], 1],
    ['a later derived verdict replaces a derived one', ['hook', 'edit_revert'], 2],
  ] as const)('%s', (_name, sources, winner) => {
    const rows = [verdict(1, sources[0], 'failed'), verdict(2, sources[1], 'mixed')];
    expect(projectRunVerdicts(rows).get('run-1')).toEqual({
      seq: winner,
      source: sources[winner - 1],
      ts: 1_791_458_400_000 + winner,
      verdict: winner === 1 ? 'failed' : 'mixed',
    });
  });

  it('keeps one label per run and ignores other events', () => {
    const rows: HostLogRow[] = [
      verdict(1, 'user', 'succeeded', 'run-a'),
      {
        event: { outcome: 'completed', runId: 'run-b', type: 'run.finished' },
        seq: 2,
        threadId: 'thread-1',
      },
      verdict(3, 'hook', 'failed', 'run-b'),
    ];
    const projected = projectRunVerdicts(rows);
    expect([...projected.keys()]).toEqual(['run-a', 'run-b']);
    expect(projected.get('run-b')).toMatchObject({ source: 'hook', verdict: 'failed' });
  });
});
