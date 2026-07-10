import { describe, expect, it } from 'vitest';
import {
  mergeSubagentToolRows,
  readLiveSubagentToolRows,
  readSubAgentToolRows,
} from '../subagent-tool-rows';

const RUN_EVENT_NAME = 'brainstrike.run-event';

function liveEventPart(args: {
  kind: string;
  parentToolCallId: string;
  toolCallId: string;
  childToolName?: string;
}) {
  return {
    data: {
      id: `${args.kind}-${args.toolCallId}`,
      kind: args.kind,
      label: args.kind,
      metadata: {
        parentToolCallId: args.parentToolCallId,
        personaId: 'explore',
        toolCallId: args.toolCallId,
        ...(args.childToolName ? { childToolName: args.childToolName } : {}),
      },
      status: 'running',
      timestamp: '2026-07-10T00:00:00.000Z',
    },
    name: RUN_EVENT_NAME,
    type: 'data',
  };
}

describe('readSubAgentToolRows (persisted)', () => {
  it('maps subAgentToolResults to success/error rows keyed by child toolCallId', () => {
    const rows = readSubAgentToolRows({
      subAgentToolResults: [
        { args: { pattern: 'flag' }, isError: false, toolCallId: 'c1', toolName: 'grep' },
        { args: {}, isError: true, toolCallId: 'c2', toolName: 'read' },
      ],
    });
    expect(rows).toEqual([
      { argSummary: 'flag', key: 'c1', status: 'success', toolName: 'grep' },
      { argSummary: undefined, key: 'c2', status: 'error', toolName: 'read' },
    ]);
  });

  it('returns [] for a missing/invalid result', () => {
    expect(readSubAgentToolRows(undefined)).toEqual([]);
    expect(readSubAgentToolRows({ text: 'no rows' })).toEqual([]);
  });
});

describe('readLiveSubagentToolRows (in-flight run events)', () => {
  it('builds a running row from a subagent.tool.started event matching the parent', () => {
    const rows = readLiveSubagentToolRows(
      [
        liveEventPart({
          childToolName: 'brainstrike_grepSearch',
          kind: 'subagent.tool.started',
          parentToolCallId: 'delegation-1',
          toolCallId: 'child-1',
        }),
      ],
      'delegation-1'
    );
    expect(rows).toEqual([
      {
        argSummary: undefined,
        key: 'child-1',
        status: 'running',
        toolName: 'brainstrike_grepSearch',
      },
    ]);
  });

  it('advances a child from running to success as later events arrive', () => {
    const rows = readLiveSubagentToolRows(
      [
        liveEventPart({
          childToolName: 'grep',
          kind: 'subagent.tool.started',
          parentToolCallId: 'delegation-1',
          toolCallId: 'child-1',
        }),
        liveEventPart({
          childToolName: 'grep',
          kind: 'subagent.tool.completed',
          parentToolCallId: 'delegation-1',
          toolCallId: 'child-1',
        }),
      ],
      'delegation-1'
    );
    expect(rows).toEqual([
      { argSummary: undefined, key: 'child-1', status: 'success', toolName: 'grep' },
    ]);
  });

  it('maps subagent.tool.failed to an error row', () => {
    const rows = readLiveSubagentToolRows(
      [
        liveEventPart({
          kind: 'subagent.tool.failed',
          parentToolCallId: 'delegation-1',
          toolCallId: 'child-1',
        }),
      ],
      'delegation-1'
    );
    expect(rows[0]?.status).toBe('error');
  });

  it('ignores events for a different parent delegation and non-subagent-tool events', () => {
    const rows = readLiveSubagentToolRows(
      [
        liveEventPart({
          kind: 'subagent.tool.started',
          parentToolCallId: 'other-delegation',
          toolCallId: 'child-x',
        }),
        { data: { kind: 'tool.started' }, name: RUN_EVENT_NAME, type: 'data' },
        { text: 'hi', type: 'text' },
      ],
      'delegation-1'
    );
    expect(rows).toEqual([]);
  });
});

describe('mergeSubagentToolRows', () => {
  it('unions live and persisted rows, with persisted superseding by key', () => {
    const live = [
      { argSummary: undefined, key: 'child-1', status: 'running' as const, toolName: 'grep' },
      { argSummary: undefined, key: 'child-2', status: 'running' as const, toolName: 'read' },
    ];
    const persisted = [
      { argSummary: 'flag', key: 'child-1', status: 'success' as const, toolName: 'grep' },
    ];
    // child-1 is superseded by the persisted (completed) row; child-2 stays live.
    expect(mergeSubagentToolRows(persisted, live)).toEqual([
      { argSummary: 'flag', key: 'child-1', status: 'success', toolName: 'grep' },
      { argSummary: undefined, key: 'child-2', status: 'running', toolName: 'read' },
    ]);
  });

  it('a running delegation with only live events yields a non-zero row count', () => {
    const merged = mergeSubagentToolRows(
      [],
      [{ argSummary: undefined, key: 'child-1', status: 'running' as const, toolName: 'grep' }]
    );
    expect(merged).toHaveLength(1);
  });
});
