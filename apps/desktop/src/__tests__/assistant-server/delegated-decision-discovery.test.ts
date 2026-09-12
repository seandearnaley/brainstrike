import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSuspendedRunsRequest } from '../../assistant-server/status-endpoints';
import { createRunRequest } from './_harness';

const {
  mockListSuspendedMastraRuns,
  mockListSuspendedChildContinuation,
  mockDesktopDatabase,
  mockGetDatabase,
} = vi.hoisted(() => ({
  mockDesktopDatabase: { query: vi.fn() },
  mockGetDatabase: vi.fn(),
  mockListSuspendedChildContinuation: vi.fn(),
  mockListSuspendedMastraRuns: vi.fn(),
}));
vi.mock('@brainstrike/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/agent')>()),
  listSuspendedChildContinuation: mockListSuspendedChildContinuation,
  listSuspendedMastraRuns: mockListSuspendedMastraRuns,
}));
vi.mock('../../db-main', () => ({ getDatabase: mockGetDatabase }));
vi.mock('../../assistant-server/mastra-memory', () => ({
  getDesktopMastraMemory: async () => ({ memory: {}, storage: {} }),
}));
const runRequest = createRunRequest((req, res, options = {}) =>
  handleSuspendedRunsRequest(req, res, options)
);

beforeEach(() => {
  mockGetDatabase.mockReset().mockResolvedValue(mockDesktopDatabase);
  mockDesktopDatabase.query.mockReset().mockResolvedValue({ rows: [] });
  mockListSuspendedMastraRuns.mockReset().mockResolvedValue({ approvals: [], suspends: [] });
  mockListSuspendedChildContinuation.mockReset().mockResolvedValue({ approvals: [], suspends: [] });
});

describe('delegated decision rediscovery HTTP contract', () => {
  it.each(['claimed', 'consumed', 'interrupted'])(
    'reports the durable %s state for the exact delegated leaf only',
    async (state) => {
      const delegation = {
        path: [
          {
            childRuntimeRunId: 'child-run',
            parentRuntimeRunId: 'root-run',
            parentToolCallId: 'root-call',
            personaId: 'worker',
          },
        ],
        toolCallId: 'leaf-call',
      };
      const pause = {
        delegation,
        runId: 'root-run',
        suspendedAt: new Date().toISOString(),
        toolCallId: 'root-call',
        toolName: 'brainstrike.executeCommand',
      };
      mockListSuspendedMastraRuns.mockResolvedValueOnce({
        approvals: [pause, { ...pause, delegation: { ...delegation, toolCallId: 'next-leaf' } }],
        suspends: [
          { ...pause, suspendPayload: { question: 'Continue?' }, toolName: 'brainstrike.askUser' },
        ],
      });
      mockDesktopDatabase.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValue({
        rows: [
          {
            childRuntimeRunId: 'child-run',
            leafToolCallId: 'leaf-call',
            runId: 'root-run',
            state,
            toolCallId: 'root-call',
          },
        ],
      });
      const response = await runRequest({
        method: 'GET',
        url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
      });
      expect(response.status).toBe(200);
      expect(mockDesktopDatabase.query).toHaveBeenCalledTimes(2);
      expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'WHERE decision.owner_resource_id = $1 AND decision.root_thread_id = $2'
        ),
        [
          'workspace-a',
          'thread-1',
          JSON.stringify([
            ['root-run', 'root-call', 'child-run', 'leaf-call', ['child-run']],
            ['root-run', 'root-call', 'child-run', 'next-leaf', ['child-run']],
          ]),
        ]
      );
      const body: unknown = JSON.parse(response.body);
      expect(body).toMatchObject({
        approvals: [{ decisionState: state }, { delegation: { toolCallId: 'next-leaf' } }],
      });
      expect(body).toMatchObject({
        suspends: [{ decisionState: state, suspendPayload: { question: 'Continue?' } }],
      });
      expect(body).not.toMatchObject({ approvals: [{}, { decisionState: state }] });
    }
  );
});

function delegatedPause(index: number) {
  return {
    delegation: {
      path: [
        {
          childRuntimeRunId: `child-${index}`,
          parentRuntimeRunId: `root-${index}`,
          parentToolCallId: `call-${index}`,
          personaId: 'worker',
        },
      ],
      toolCallId: 'leaf-call',
    },
    runId: `root-${index}`,
    suspendedAt: '2026-09-10T00:00:00Z',
    toolCallId: `call-${index}`,
    toolName: 'brainstrike.askUser',
  };
}

it('reads decision state only for the newest returned suspends', async () => {
  mockListSuspendedMastraRuns.mockResolvedValue({
    approvals: [],
    suspends: Array.from({ length: 12 }, (_, index) => delegatedPause(index)),
  });
  const response = await runRequest({
    method: 'GET',
    url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
  });
  expect(response.status).toBe(200);
  expect(mockDesktopDatabase.query).toHaveBeenCalledTimes(2);
  expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
    expect.stringContaining('brainstrike_delegated_tool_decisions'),
    [
      'workspace-a',
      'thread-1',
      JSON.stringify(
        Array.from({ length: 10 }, (_, index) => [
          `root-${index + 2}`,
          `call-${index + 2}`,
          `child-${index + 2}`,
          'leaf-call',
          [`child-${index + 2}`],
        ])
      ),
    ]
  );
});

it('enumerates continuation receipts without reading leaf claims for ordinary pauses', async () => {
  const { delegation: _delegation, ...pause } = delegatedPause(0);
  mockListSuspendedMastraRuns.mockResolvedValue({ approvals: [pause], suspends: [] });
  const response = await runRequest({
    method: 'GET',
    url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
  });
  expect(response.status).toBe(200);
  expect(mockGetDatabase).toHaveBeenCalled();
  expect(mockDesktopDatabase.query).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('brainstrike_delegated_continuations'),
    ['workspace-a', 'thread-1']
  );
});

it.each(['query failure', 'unknown saved state'])(
  'fails visibly on %s rather than offering a consumed decision again',
  async (failure) => {
    mockListSuspendedMastraRuns.mockResolvedValue({ approvals: [], suspends: [delegatedPause(0)] });
    if (failure === 'query failure') {
      mockDesktopDatabase.query.mockRejectedValue(new Error('Cannot read decisions'));
    } else {
      mockDesktopDatabase.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValue({
        rows: [
          {
            childRuntimeRunId: 'child-0',
            leafToolCallId: 'leaf-call',
            runId: 'root-0',
            state: 'unknown',
            toolCallId: 'call-0',
          },
        ],
      });
    }
    const response = await runRequest({
      method: 'GET',
      url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
    });
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: 'suspended_runs_failed',
      message: 'Suspended approval discovery failed.',
    });
  }
);

it('fails the whole discovery visibly when an owned receipt loses its authorized ancestry', async () => {
  mockListSuspendedMastraRuns.mockResolvedValue({
    approvals: [{ ...delegatedPause(0), delegation: undefined }],
    suspends: [],
  });
  mockDesktopDatabase.query
    .mockResolvedValueOnce({ rows: [{ id: 'unverifiable-child' }] })
    .mockResolvedValue({ rows: [] });
  const response = await runRequest({
    method: 'GET',
    url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
  });
  expect(response.status).toBe(500);
  expect(JSON.parse(response.body)).toEqual({
    error: 'suspended_runs_failed',
    message: 'Suspended approval discovery failed.',
  });
});

it('rejects an invalid suspension timestamp even when there is only one child decision', async () => {
  mockDesktopDatabase.query
    .mockResolvedValueOnce({ rows: [{ id: 'receipt' }] })
    .mockResolvedValueOnce({ rows: [{ id: 'thread-1' }] })
    .mockResolvedValueOnce({
      rows: [
        {
          configuration: { persona: { id: 'worker' } },
          delegation_depth: 1,
          id: 'receipt',
          native_run_id: 'native-child',
          parent_thread_id: 'thread-1',
          resource_id: 'child-resource',
          state: 'awaiting-approval',
          thread_id: 'child',
          turn_message_id: 'turn',
        },
      ],
    });
  mockListSuspendedChildContinuation.mockResolvedValue({
    approvals: [
      {
        continuationId: 'receipt',
        runId: 'native-child',
        suspendedAt: 'invalid',
        toolCallId: 'call',
        toolName: 'brainstrike.executeCommand',
      },
    ],
    suspends: [],
  });
  const response = await runRequest({
    method: 'GET',
    url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
  });
  expect(mockListSuspendedChildContinuation).toHaveBeenCalledOnce();
  expect(response.status).toBe(500);
  expect(JSON.parse(response.body)).toEqual({
    error: 'suspended_runs_failed',
    message: 'Suspended approval discovery failed.',
  });
});
