import { addLogListener, LogLevel, setLogLevel } from '@brainstrike/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSuspendedApprovalDiscovery } from '../assistant-suspended-approvals';

interface CapturedLog {
  readonly level: string;
  readonly message: string;
}

function makeResponse(status: number, body: unknown): Response {
  return {
    json: () => Promise.resolve(body),
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response;
}

describe('createSuspendedApprovalDiscovery', () => {
  const resolveBaseUrl = (): Promise<string> => Promise.resolve('http://127.0.0.1:9999/');
  let logs: CapturedLog[];
  let removeLogListener: () => void;

  beforeEach(() => {
    setLogLevel(LogLevel.WARN);
    logs = [];
    removeLogListener = addLogListener((entry) => {
      logs.push({ level: entry.level ?? '', message: entry.message ?? '' });
    });
  });

  afterEach(() => {
    removeLogListener();
  });

  it('fetches the encoded suspended-runs endpoint and returns parsed approvals', async () => {
    const approval = {
      runId: 'run-1',
      stale: false,
      suspendedAt: '2026-07-09T00:00:00.000Z',
      toolCallId: 'call-1',
      toolName: 'brainstrike.executeCommand',
    };
    const fetchImpl = vi.fn(() => Promise.resolve(makeResponse(200, { approvals: [approval] })));

    const discover = createSuspendedApprovalDiscovery(resolveBaseUrl, fetchImpl);
    const result = await discover('thread a', 'workspace/1');

    expect(result).toEqual([approval]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requestedUrl = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(requestedUrl).toBe(
      'http://127.0.0.1:9999/assistant/suspended-runs?threadId=thread%20a&resourceId=workspace%2F1'
    );
  });

  it('drops a malformed entry with a warning but keeps the valid ones', async () => {
    const valid = {
      runId: 'run-1',
      stale: true,
      suspendedAt: '2026-07-09T00:00:00.000Z',
      toolCallId: 'call-1',
      toolName: 'brainstrike.writeWorkspaceFile',
    };
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        makeResponse(200, { approvals: [valid, { runId: 'run-2' /* missing fields */ }] })
      )
    );

    const discover = createSuspendedApprovalDiscovery(resolveBaseUrl, fetchImpl);
    const result = await discover('thread-1', 'workspace-1');

    expect(result).toEqual([valid]);
    expect(logs.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('returns [] and logs an error on a non-ok HTTP response (never a silent success)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(makeResponse(500, { error: 'boom' })));

    const discover = createSuspendedApprovalDiscovery(resolveBaseUrl, fetchImpl);
    const result = await discover('thread-1', 'workspace-1');

    expect(result).toEqual([]);
    expect(logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('returns [] and logs an error when fetch rejects', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('network down')));

    const discover = createSuspendedApprovalDiscovery(resolveBaseUrl, fetchImpl);
    const result = await discover('thread-1', 'workspace-1');

    expect(result).toEqual([]);
    expect(logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('short-circuits to [] without a request when thread context is empty', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(makeResponse(200, { approvals: [] })));

    const discover = createSuspendedApprovalDiscovery(resolveBaseUrl, fetchImpl);
    expect(await discover('', 'workspace-1')).toEqual([]);
    expect(await discover('thread-1', '')).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
