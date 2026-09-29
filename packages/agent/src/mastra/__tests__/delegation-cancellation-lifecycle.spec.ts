import { describe, expect, it } from 'vitest';
import { processMastraStreamPart } from '../agent-streaming';
import { makeDelegatedStreamTermination } from '../stream-termination';
import { createTurnAttemptLifecycleState } from '../turn-attempts';

describe('delegation cancellation lifecycle', () => {
  it('settles the delegation tool as cancelled without flushing nested output as success', async () => {
    const state = createTurnAttemptLifecycleState(undefined, undefined, undefined);
    const names = new Map<string, string>();
    const personas = new Map([['agent-explore', 'explore']]);
    const start = await processMastraStreamPart(
      {
        args: { task: 'inspect' },
        toolCallId: 'delegation-1',
        toolName: 'agent-explore',
        type: 'tool-call',
      },
      names,
      state,
      undefined,
      undefined,
      personas
    );
    const nestedOutput = await processMastraStreamPart(
      {
        output: { payload: { toolCallId: 'child-read', toolName: 'read' }, type: 'tool-call' },
        toolCallId: 'delegation-1',
        toolName: 'agent-explore',
        type: 'tool-output',
      },
      names,
      state,
      undefined,
      undefined,
      personas
    );

    expect(
      start.chunks.filter((chunk) => chunk.type === 'run-event').map((chunk) => chunk.event.kind)
    ).toEqual(['tool.started', 'subagent.started']);
    expect(
      nestedOutput.chunks
        .filter((chunk) => chunk.type === 'run-event')
        .map((chunk) => chunk.event.kind)
    ).toEqual(['subagent.tool.started']);
    expect(state.outputOnlyToolEvents.has('delegation-1')).toBe(false);

    const terminal = makeDelegatedStreamTermination(state, true);
    expect(
      terminal
        .filter((chunk) => chunk.type === 'run-event')
        .map((chunk) => [chunk.event.kind, chunk.event.status])
    ).toEqual([
      ['subagent.failed', 'cancelled'],
      ['tool.failed', 'cancelled'],
      ['run.cancelled', 'cancelled'],
    ]);
    expect(state.terminalToolCallStates.get('delegation-1')).toBe('failed');

    const lateResult = await processMastraStreamPart(
      {
        result: { text: 'late' },
        toolCallId: 'delegation-1',
        toolName: 'agent-explore',
        type: 'tool-result',
      },
      names,
      state,
      undefined,
      undefined,
      personas
    );
    expect(lateResult.chunks.filter((chunk) => chunk.type === 'run-event')).toEqual([]);
  });
});
