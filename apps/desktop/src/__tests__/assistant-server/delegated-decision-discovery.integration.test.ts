import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSuspendedRunsRequest } from '../../assistant-server/status-endpoints';
import { createRunRequest } from './_harness';

const { mockListSuspendedMastraRuns, mockDesktopDatabase } = vi.hoisted(() => ({
  mockDesktopDatabase: { query: vi.fn() },
  mockListSuspendedMastraRuns: vi.fn(),
}));
vi.mock('@brainstrike/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/agent')>()),
  listSuspendedMastraRuns: mockListSuspendedMastraRuns,
}));
vi.mock('../../db-main', () => ({ getDatabase: async () => mockDesktopDatabase }));
vi.mock('../../assistant-server/mastra-memory', () => ({
  getDesktopMastraMemory: async () => ({ memory: {}, storage: {} }),
}));
const runRequest = createRunRequest((req, res, options = {}) =>
  handleSuspendedRunsRequest(req, res, options)
);

beforeEach(() => {
  mockDesktopDatabase.query.mockReset().mockResolvedValue({ rows: [] });
  mockListSuspendedMastraRuns.mockReset().mockResolvedValue({ approvals: [], suspends: [] });
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
      mockDesktopDatabase.query.mockResolvedValueOnce({
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
