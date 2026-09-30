import { expect, it } from 'vitest';
import {
  advanceAnsweredApprovalsIndex,
  createMutableApprovalsIndex,
} from '../answered-approvals-index-model';
import { approvalCardToolCallIds } from '../approval-history';

const request = {
  delegation: {
    path: [
      {
        childRuntimeRunId: 'child',
        parentRuntimeRunId: 'root',
        parentToolCallId: 'delegate',
        personaId: 'explore',
      },
    ],
    toolCallId: 'call_0',
  },
  hostRunId: 'host-root',
  runId: 'root',
  timelineRunId: 'host-root',
  toolCallId: 'delegate',
  toolName: 'brainstrike.readWorkspaceFile',
};
it('replaces only the tool call addressed on this surface, not a reused child leaf id', () => {
  const ids = approvalCardToolCallIds([
    { data: request, name: 'brainstrike.tool-approval', type: 'data' },
  ]);
  expect([...ids]).toEqual(['delegate']);
  expect(ids.has('call_0')).toBe(false);
});
it('never hides activity for malformed, unknown, or absent approval cards', () => {
  expect(
    approvalCardToolCallIds([
      null,
      {},
      { data: request, name: 'unknown', type: 'data' },
      { data: { toolCallId: 'delegate' }, name: 'brainstrike.tool-approval', type: 'data' },
    ]).size
  ).toBe(0);
});

function indexedCalls() {
  const index = createMutableApprovalsIndex();
  advanceAnsweredApprovalsIndex(
    [{ content: [{ data: request, name: 'brainstrike.tool-approval', type: 'data' }] }],
    { keys: [], scanned: [] },
    index
  );
  return index.cardedSurfaceCalls;
}
function pause(runId: string | undefined, toolCallId: string, kind = 'tool.approval.requested') {
  return {
    data: {
      id: 'pause',
      kind,
      label: 'Approval requested',
      status: 'running',
      timestamp: '2026-09-28T19:03:00Z',
      ...(runId === undefined ? {} : { runId }),
      metadata: { toolCallId },
    },
    name: 'brainstrike.run-event',
    type: 'data',
  };
}
it('finds a separate card using the recorded run and surface call', () => {
  expect([...approvalCardToolCallIds([pause('host-root', 'delegate')], indexedCalls())]).toEqual([
    'delegate',
  ]);
});
it('uses an exact tool start when the matching pause lives outside this message', () => {
  expect([
    ...approvalCardToolCallIds([pause('host-root', 'delegate', 'tool.started')], indexedCalls()),
  ]).toEqual(['delegate']);
});
it.each(['tool.completed', 'tool.failed', 'run.started', 'run.finished'])(
  'does not infer a pause owner from %s',
  (kind) => {
    expect(
      approvalCardToolCallIds([pause('host-root', 'delegate', kind)], indexedCalls()).size
    ).toBe(0);
  }
);
it.each([
  ['another run', 'other', 'delegate'],
  ['a child timeline', 'host-child', 'delegate'],
  ['the native run namespace', 'root', 'delegate'],
  ['another call', 'host-root', 'other-call'],
  ['a child leaf', 'host-root', 'call_0'],
  ['an unscoped pause', undefined, 'delegate'],
] as const)('does not replace %s with an unrelated approval card', (_, runId, toolCallId) => {
  expect(approvalCardToolCallIds([pause(runId, toolCallId)], indexedCalls()).size).toBe(0);
  expect(
    approvalCardToolCallIds([pause(runId, toolCallId, 'tool.started')], indexedCalls()).size
  ).toBe(0);
});

it('does not guess a host leg for a rediscovered request without one', () => {
  const withoutHost = createMutableApprovalsIndex();
  const { timelineRunId: _timelineRunId, ...rediscovered } = request;
  advanceAnsweredApprovalsIndex(
    [{ content: [{ data: rediscovered, name: 'brainstrike.tool-approval', type: 'data' }] }],
    { keys: [], scanned: [] },
    withoutHost
  );
  expect(withoutHost.cardedSurfaceCalls.size).toBe(0);
});

it('a child surface matches its own leaf call, never the root transport alias or a sibling timeline', () => {
  const index = createMutableApprovalsIndex();
  const childRequest = {
    ...request,
    runId: 'child',
    timelineRunId: 'host-child',
    toolCallId: 'call_0',
  };
  advanceAnsweredApprovalsIndex(
    [{ content: [{ data: childRequest, name: 'brainstrike.tool-approval', type: 'data' }] }],
    { keys: [], scanned: [] },
    index
  );
  expect([
    ...approvalCardToolCallIds([pause('host-child', 'call_0')], index.cardedSurfaceCalls),
  ]).toEqual(['call_0']);
  for (const [runId, callId] of [
    ['host-root', 'call_0'],
    ['host-sibling', 'call_0'],
    ['host-child', 'delegate'],
  ] as const) {
    expect(approvalCardToolCallIds([pause(runId, callId)], index.cardedSurfaceCalls).size).toBe(0);
  }
});
