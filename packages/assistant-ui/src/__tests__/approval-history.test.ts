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
