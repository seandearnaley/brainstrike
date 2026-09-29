import { expect, it } from 'vitest';
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

const indexed = new Map([['approval', { decided: false, request }]]);
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
  expect([...approvalCardToolCallIds([pause('root', 'delegate')], indexed)]).toEqual(['delegate']);
});
it.each([
  ['another run', 'other', 'delegate'],
  ['another call', 'root', 'other-call'],
  ['a child leaf', 'root', 'call_0'],
  ['an unscoped pause', undefined, 'delegate'],
] as const)('does not replace %s with an unrelated approval card', (_, runId, toolCallId) => {
  expect(approvalCardToolCallIds([pause(runId, toolCallId)], indexed).size).toBe(0);
});
