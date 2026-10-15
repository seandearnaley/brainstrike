// @vitest-environment node
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  mergeSubagentToolRows,
  readLiveSubagentToolRows,
  readLiveSubagentToolRowsFromMessages,
  readSubAgentToolRows,
  readSubagentDelegationOutcome,
  serializeLiveSubagentToolRows,
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

function terminalEventPart(args: {
  kind: string;
  outcome?: string;
  parentToolCallId: string;
  status: string;
}) {
  return {
    data: {
      id: `${args.kind}-${args.parentToolCallId}`,
      kind: args.kind,
      label: args.kind,
      metadata: {
        parentToolCallId: args.parentToolCallId,
        personaId: 'explore',
        ...(args.outcome ? { outcome: args.outcome } : {}),
      },
      status: args.status,
      timestamp: '2026-07-10T00:00:00.000Z',
    },
    name: RUN_EVENT_NAME,
    type: 'data',
  };
}

describe('readSubagentDelegationOutcome', () => {
  // BST-1410. A child that exhausts its step cap mid-tool-loop still produces a
  // SUCCESSFUL delegation tool call, so `status.type` cannot distinguish it. The
  // discriminator is the terminal run event's bounded `outcome` metadata — never
  // the human label, which a hard child failure shares.
  it("reports 'no-answer' for this delegation's terminal event", () => {
    const parts = [
      terminalEventPart({
        kind: 'subagent.failed',
        outcome: 'no-answer',
        parentToolCallId: 'delegation-1',
        status: 'failed',
      }),
    ];
    expect(readSubagentDelegationOutcome(parts, 'delegation-1')).toBe('no-answer');
  });

  it("reports 'rejected' for a delegation refused before its child ran (BST-1751)", () => {
    const parts = [
      terminalEventPart({
        kind: 'subagent.failed',
        outcome: 'rejected',
        parentToolCallId: 'delegation-1',
        status: 'failed',
      }),
    ];
    expect(readSubagentDelegationOutcome(parts, 'delegation-1')).toBe('rejected');
  });

  it("reports 'truncated' for a completed delegation whose reserved summary was cut", () => {
    const parts = [
      terminalEventPart({
        kind: 'subagent.finished',
        outcome: 'truncated',
        parentToolCallId: 'delegation-1',
        status: 'completed',
      }),
    ];
    expect(readSubagentDelegationOutcome(parts, 'delegation-1')).toBe('truncated');
    expect(readSubagentDelegationOutcome(parts, 'delegation-2')).toBeUndefined();
  });

  it('ignores a terminal event belonging to a DIFFERENT concurrent delegation', () => {
    // MAX_CONCURRENT_DELEGATIONS is 2, so two delegations are open at once.
    const parts = [
      terminalEventPart({
        kind: 'subagent.failed',
        outcome: 'no-answer',
        parentToolCallId: 'delegation-2',
        status: 'failed',
      }),
    ];
    expect(readSubagentDelegationOutcome(parts, 'delegation-1')).toBeUndefined();
  });

  it('reports nothing for a hard failure or a cancellation (no outcome marker)', () => {
    const parts = [
      terminalEventPart({
        kind: 'subagent.failed',
        parentToolCallId: 'delegation-1',
        status: 'cancelled',
      }),
    ];
    expect(readSubagentDelegationOutcome(parts, 'delegation-1')).toBeUndefined();
  });

  it('reports nothing for a delegation that answered', () => {
    const parts = [
      terminalEventPart({
        kind: 'subagent.finished',
        parentToolCallId: 'delegation-1',
        status: 'completed',
      }),
    ];
    expect(readSubagentDelegationOutcome(parts, 'delegation-1')).toBeUndefined();
  });
});

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

  it('D2: derives one row per child for a full 10-tool live delegation (no undercount)', () => {
    const parts: unknown[] = [];
    for (let index = 0; index < 10; index += 1) {
      parts.push(
        liveEventPart({
          childToolName: 'brainstrike_grepSearch',
          kind: 'subagent.tool.started',
          parentToolCallId: 'delegation-1',
          toolCallId: `child-${index}`,
        }),
        liveEventPart({
          childToolName: 'brainstrike_grepSearch',
          kind: 'subagent.tool.completed',
          parentToolCallId: 'delegation-1',
          toolCallId: `child-${index}`,
        })
      );
    }
    const rows = readLiveSubagentToolRows(parts, 'delegation-1');
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.status === 'success')).toBe(true);
  });

  it('ignores events for a different parent delegation and non-subagent-tool events', () => {
    const rows = readLiveSubagentToolRows(
      [
        liveEventPart({
          kind: 'subagent.tool.started',
          parentToolCallId: 'other-delegation',
          toolCallId: 'child-x',
        }),
        liveEventPart({
          kind: 'subagent.tool.started',
          parentToolCallId: 'delegation-1',
          toolCallId: '',
        }),
        { data: { kind: 'tool.started' }, name: RUN_EVENT_NAME, type: 'data' },
        { text: 'hi', type: 'text' },
      ],
      'delegation-1'
    );
    expect(rows).toEqual([]);
  });
});

describe('serializeLiveSubagentToolRows (D2 value-stable selector)', () => {
  const started = (toolCallId: string) =>
    liveEventPart({
      childToolName: 'grep',
      kind: 'subagent.tool.started',
      parentToolCallId: 'delegation-1',
      toolCallId,
    });

  it('is byte-identical for equal inputs (so useAuiState does NOT over-render)', () => {
    const parts = [started('child-1')];
    expect(serializeLiveSubagentToolRows(parts, 'delegation-1')).toBe(
      serializeLiveSubagentToolRows([...parts], 'delegation-1')
    );
  });

  it('changes value when a new child event is appended (so useAuiState re-renders)', () => {
    const before = serializeLiveSubagentToolRows([started('child-1')], 'delegation-1');
    const after = serializeLiveSubagentToolRows(
      [started('child-1'), started('child-2')],
      'delegation-1'
    );
    expect(after).not.toBe(before);
    expect(JSON.parse(after)).toHaveLength(2);
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

describe('readLiveSubagentToolRowsFromMessages', () => {
  // Field failure (2026-08-24): on reload, hydration weaves a run's
  // subagent.tool.* events into ONE assistant group, and an approval-resume
  // turn splits into sibling groups — so the events can land on a DIFFERENT
  // message than the delegation card. The card read only its own message's
  // parts and showed "0 tool calls" for a child that did four minutes of
  // work. Events are parentToolCallId-scoped by design, so a thread-wide read
  // is safe and reload-robust.
  it('finds rows woven into a SIBLING message', async () => {
    const { readLiveSubagentToolRowsFromMessages } = await import('../subagent-tool-rows');
    const messages = [
      { parts: [{ text: 'card lives here, events do not', type: 'text' }] },
      {
        parts: [
          liveEventPart({
            childToolName: 'readWorkspaceFile',
            kind: 'subagent.tool.completed',
            parentToolCallId: 'parent-1',
            toolCallId: 'child-1',
          }),
        ],
      },
    ];
    const rows = readLiveSubagentToolRowsFromMessages(messages, 'parent-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'success', toolName: 'readWorkspaceFile' });
  });

  it('ignores rows belonging to a different delegation', async () => {
    const { readLiveSubagentToolRowsFromMessages } = await import('../subagent-tool-rows');
    const messages = [
      {
        parts: [
          liveEventPart({
            kind: 'subagent.tool.completed',
            parentToolCallId: 'someone-else',
            toolCallId: 'child-9',
          }),
        ],
      },
    ];
    expect(readLiveSubagentToolRowsFromMessages(messages, 'parent-1')).toHaveLength(0);
  });
});

describe('readLiveSubagentToolRowsFromMessages — interrupted rule', () => {
  const started = {
    data: {
      id: 'c-s',
      kind: 'subagent.tool.started',
      label: 'Subagent tool started',
      metadata: {
        childToolName: 'brainstrike_grepSearch',
        parentToolCallId: 'p1',
        toolCallId: 'c1',
      },
      status: 'running',
      timestamp: '2026-09-07T00:00:00.000Z',
    },
    name: ASSISTANT_RUN_EVENT_DATA_NAME,
    type: 'data',
  };

  it('marks a running child row interrupted when its message has settled', () => {
    const rows = readLiveSubagentToolRowsFromMessages(
      [{ parts: [started], status: { reason: 'stop', type: 'complete' } }],
      'p1'
    );
    expect(rows).toEqual([
      {
        argSummary: undefined,
        key: 'c1',
        status: 'interrupted',
        toolName: 'brainstrike_grepSearch',
      },
    ]);
  });

  it('keeps the row running while the message runs, and when the message carries no status', () => {
    for (const message of [
      { parts: [started], status: { type: 'running' } },
      { parts: [started] },
    ]) {
      expect(readLiveSubagentToolRowsFromMessages([message], 'p1')[0]?.status).toBe('running');
    }
  });
});

describe('readLiveSubagentToolRowsFromMessages — cross-message pairing', () => {
  // Field shape: a delegation's `subagent.tool.started` and its matching
  // `subagent.tool.completed` can land on DIFFERENT messages (hydration
  // weaves a run's events into one group, but an approval-resume turn splits
  // into sibling messages). `readLiveSubagentToolRowsFromMessages` iterates
  // messages in thread order and lets a later event's `Map.set` supersede an
  // earlier one, so the started message being already `complete` must not
  // strand the row at `interrupted` once its completed pair arrives later.
  const startedEvent = () =>
    liveEventPart({
      childToolName: 'brainstrike_grepSearch',
      kind: 'subagent.tool.started',
      parentToolCallId: 'p1',
      toolCallId: 'c1',
    });
  const completedEvent = () =>
    liveEventPart({
      childToolName: 'brainstrike_grepSearch',
      kind: 'subagent.tool.completed',
      parentToolCallId: 'p1',
      toolCallId: 'c1',
    });

  it('pairs a started row on a settled message with its completed on a later running message (NOT interrupted)', () => {
    const rows = readLiveSubagentToolRowsFromMessages(
      [
        { parts: [startedEvent()], status: { reason: 'stop', type: 'complete' } },
        { parts: [completedEvent()], status: { type: 'running' } },
      ],
      'p1'
    );
    expect(rows).toEqual([
      { argSummary: undefined, key: 'c1', status: 'success', toolName: 'brainstrike_grepSearch' },
    ]);
  });

  it('mirror: still success when BOTH the started and completed messages have already settled', () => {
    const rows = readLiveSubagentToolRowsFromMessages(
      [
        { parts: [startedEvent()], status: { reason: 'stop', type: 'complete' } },
        { parts: [completedEvent()], status: { reason: 'stop', type: 'complete' } },
      ],
      'p1'
    );
    expect(rows).toEqual([
      { argSummary: undefined, key: 'c1', status: 'success', toolName: 'brainstrike_grepSearch' },
    ]);
  });
});
