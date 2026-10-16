// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deriveStepMeta } from '../activity-step-meta';
import type { ActivityStep } from '../activity-trace-model';
import { verbForTool } from '../activity-verbs';

const step = (
  id: string,
  state: ActivityStep['state'],
  partIndex: number,
  kind: ActivityStep['kind'] = 'tool'
): ActivityStep => ({
  durationMs: undefined,
  id,
  kind,
  partIndex,
  ran: true,
  state,
  target: null,
  targetKey: null,
  verb: verbForTool('brainstrike.readWorkspaceFile'),
});

describe('deriveStepMeta', () => {
  it('names the last running TOOL step in part order', () => {
    expect(
      deriveStepMeta([step('a', 'done', 0), step('b', 'running', 2), step('c', 'running', 3)])
    ).toEqual({ lastRunningId: 'c' });
  });

  it('ignores reasoning steps and yields null when no tool step runs', () => {
    expect(
      deriveStepMeta([step('reasoning-0', 'running', 0, 'reasoning'), step('a', 'waiting', 1)])
    ).toEqual({ lastRunningId: null });
    expect(deriveStepMeta([])).toEqual({ lastRunningId: null });
  });
});
