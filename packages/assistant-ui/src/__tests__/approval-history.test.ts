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

const index = createMutableApprovalsIndex();
advanceAnsweredApprovalsIndex(
  [{ content: [{ data: request, name: 'brainstrike.tool-approval', type: 'data' }] }],
  { keys: [], scanned: [] },
  index
);
const indexed = index.cardedSurfaceCalls;
function pause(runId: string | undefined, toolCallId: string) {
  return {
    data: {
      id: 'pause',
      kind: 'tool.approval.requested',
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
  expect([...approvalCardToolCallIds([pause('host-root', 'delegate')], indexed)]).toEqual([
    'delegate',
  ]);
});
it.each([
  ['another run', 'other', 'delegate'],
  ['the native run namespace', 'root', 'delegate'],
  ['another call', 'host-root', 'other-call'],
  ['a child leaf', 'host-root', 'call_0'],
  ['an unscoped pause', undefined, 'delegate'],
] as const)('does not replace %s with an unrelated approval card', (_, runId, toolCallId) => {
  expect(approvalCardToolCallIds([pause(runId, toolCallId)], indexed).size).toBe(0);
});

it('does not guess a host leg for a rediscovered request without one', () => {
  const withoutHost = createMutableApprovalsIndex();
  const { hostRunId: _hostRunId, ...rediscovered } = request;
  advanceAnsweredApprovalsIndex(
    [{ content: [{ data: rediscovered, name: 'brainstrike.tool-approval', type: 'data' }] }],
    { keys: [], scanned: [] },
    withoutHost
  );
  expect(withoutHost.cardedSurfaceCalls.size).toBe(0);
});
