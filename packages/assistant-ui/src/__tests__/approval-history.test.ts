// @vitest-environment node
import { getToolActionIdentityKey } from '@brainstrike/assistant-contract';
import type { AssistantToolApprovalAnswered } from '@brainstrike/assistant-contract/tool-approval';
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

function indexRequest(original = request) {
  const index = createMutableApprovalsIndex();
  advanceAnsweredApprovalsIndex(
    [{ content: [{ data: original, name: 'brainstrike.tool-approval', type: 'data' }] }],
    { keys: [], scanned: [] },
    index
  );
  return index;
}
function answerPart(
  answer: AssistantToolApprovalAnswered = { ...request, decision: 'approve', reason: 'user' }
) {
  return { data: answer, name: 'brainstrike.tool-approval-answered', type: 'data' };
}

it('uses the initiating answer in this resume message to retain the original approval history', () => {
  const index = indexRequest();
  const parts = [pause('host-resume', request.toolCallId, 'tool.started'), answerPart()];
  expect([...approvalCardToolCallIds(parts, index.cardedSurfaceCalls, index.requests)]).toEqual([
    'delegate',
  ]);
  expect(
    approvalCardToolCallIds(parts.slice(0, 1), index.cardedSurfaceCalls, index.requests).size
  ).toBe(0);
  expect(approvalCardToolCallIds(parts, index.cardedSurfaceCalls).size).toBe(0);
  expect([
    ...approvalCardToolCallIds([answerPart()], index.cardedSurfaceCalls, index.requests),
  ]).toEqual(['delegate']);
});

it('does not suppress two same-id tool parts when only one has an exact answer', () => {
  const index = indexRequest();
  const tool = { toolCallId: request.toolCallId, toolName: request.toolName, type: 'tool-call' };
  expect(
    approvalCardToolCallIds([tool, answerPart(), tool], index.cardedSurfaceCalls, index.requests)
      .size
  ).toBe(0);
});

it.each([
  ['native generation', { ...request, runId: 'other-native-run' }],
  ['surface call', { ...request, toolCallId: 'other-surface-call' }],
  ['tool', { ...request, toolName: 'brainstrike.globWorkspace' }],
  ['continuation', { ...request, continuationId: 'other-continuation' }],
  [
    'leaf generation',
    {
      ...request,
      delegation: {
        ...request.delegation,
        path: [{ ...request.delegation.path[0]!, childRuntimeRunId: 'other-child' }],
      },
    },
  ],
  [
    'parent generation',
    {
      ...request,
      delegation: {
        ...request.delegation,
        path: [{ ...request.delegation.path[0]!, parentRuntimeRunId: 'other-parent' }],
      },
    },
  ],
  [
    'parent call',
    {
      ...request,
      delegation: {
        ...request.delegation,
        path: [{ ...request.delegation.path[0]!, parentToolCallId: 'other-parent-call' }],
      },
    },
  ],
  [
    'persona',
    {
      ...request,
      delegation: {
        ...request.delegation,
        path: [{ ...request.delegation.path[0]!, personaId: 'other-persona' }],
      },
    },
  ],
  ['child leaf', { ...request, delegation: { ...request.delegation, toolCallId: 'other-leaf' } }],
  [
    'path length',
    {
      ...request,
      delegation: {
        ...request.delegation,
        path: [
          {
            childRuntimeRunId: 'root',
            parentRuntimeRunId: 'ancestor',
            parentToolCallId: 'ancestor-call',
            personaId: 'explore',
          },
          ...request.delegation.path,
        ],
      },
    },
  ],
])('retains a gate when a same-id answer has a foreign %s', (_, foreign) => {
  const index = indexRequest();
  const answer = { ...foreign, decision: 'approve' as const, reason: 'user' as const };
  expect(
    approvalCardToolCallIds([answerPart(answer)], index.cardedSurfaceCalls, index.requests).size
  ).toBe(0);
  const answerKey = getToolActionIdentityKey(answer);
  const requestKey = getToolActionIdentityKey(request);
  expect(answerKey === requestKey).toBe(!['leaf generation', 'child leaf'].includes(_));
  // Exercise the surface comparator independently of the shared leaf lookup.
  const indexedOriginal = index.requests.get(requestKey)!;
  expect(
    approvalCardToolCallIds(
      [answerPart(answer)],
      index.cardedSurfaceCalls,
      new Map([[answerKey, indexedOriginal]])
    ).size
  ).toBe(0);
});

it('requires matching delegation presence even when an indexed request is found', () => {
  const { delegation: _delegation, ...rootRequest } = request;
  const index = indexRequest();
  const rootAnswer = { ...rootRequest, decision: 'approve' as const, reason: 'user' as const };
  expect(
    approvalCardToolCallIds(
      [answerPart(rootAnswer)],
      index.cardedSurfaceCalls,
      new Map([
        [
          getToolActionIdentityKey(rootAnswer),
          index.requests.get(getToolActionIdentityKey(request))!,
        ],
      ])
    ).size
  ).toBe(0);
});

it('does not hide a reused child surface call behind a root routing alias', () => {
  const childRequest = {
    ...request,
    runId: 'child',
    timelineRunId: 'host-child',
    toolCallId: 'call_0',
  };
  const index = indexRequest(childRequest);
  // The shared decision key deliberately joins root and child views; the
  // display projection must additionally verify their DIFFERENT surface IDs.
  expect(getToolActionIdentityKey(request)).toBe(getToolActionIdentityKey(childRequest));
  expect(
    approvalCardToolCallIds([answerPart()], index.cardedSurfaceCalls, index.requests).size
  ).toBe(0);
});

it('requires a real host-owned original card rather than an unscoped rediscovery', () => {
  const index = indexRequest({ ...request, timelineRunId: '' });
  expect(
    approvalCardToolCallIds([answerPart()], index.cardedSurfaceCalls, index.requests).size
  ).toBe(0);
});
