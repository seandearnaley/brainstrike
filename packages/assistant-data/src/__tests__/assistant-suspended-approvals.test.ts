import { addLogListener, LogLevel, setLogLevel } from '@brainstrike/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSuspendedRunDiscovery } from '../assistant-suspended-approvals';

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

describe('createSuspendedRunDiscovery', () => {
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

    const discover = createSuspendedRunDiscovery(resolveBaseUrl, fetchImpl);
    const result = await discover('thread a', 'workspace/1');

    expect(result).toEqual({ approvals: [approval], suspends: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requestedUrl = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(requestedUrl).toBe(
      'http://127.0.0.1:9999/assistant/suspended-runs?threadId=thread%20a&resourceId=workspace%2F1'
    );
  });

  it('sends resolved auth headers with the discovery request', async () => {
    const token = 't'.repeat(64);
    const fetchImpl = vi.fn(() => Promise.resolve(makeResponse(200, { approvals: [] })));

    const discover = createSuspendedRunDiscovery(resolveBaseUrl, fetchImpl, undefined, () =>
      Promise.resolve({ 'x-brainstrike-assistant-token': token })
    );
    await discover('thread-1', 'workspace-1');

    const requestInit = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(requestInit.headers).toEqual({
      accept: 'application/json',
      'x-brainstrike-assistant-token': token,
    });
  });

  it('retains valid approvals and reports incomplete recovery for malformed entries', async () => {
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

    const discover = createSuspendedRunDiscovery(resolveBaseUrl, fetchImpl);
    const result = await discover('thread-1', 'workspace-1');

    expect(result).toEqual({
      approvals: [valid],
      error: { reason: 'invalid-response' },
      suspends: [],
    });
    expect(logs.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('returns an explicit discovery failure on a non-ok HTTP response', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(makeResponse(500, { error: 'boom' })));

    const discover = createSuspendedRunDiscovery(resolveBaseUrl, fetchImpl);
    const result = await discover('thread-1', 'workspace-1');

    expect(result).toEqual({ approvals: [], error: { reason: 'request-failed' }, suspends: [] });
    expect(logs.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('reports an explicit request failure when fetch rejects', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('network down')));

    const discover = createSuspendedRunDiscovery(resolveBaseUrl, fetchImpl);
    const result = await discover('thread-1', 'workspace-1');

    expect(result).toEqual({ approvals: [], error: { reason: 'request-failed' }, suspends: [] });
    expect(logs.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('bounds the request and reports an explicit timeout when the server hangs', async () => {
    // Wedged/mid-stream assistant server: fetch never resolves on its own and
    // only settles when the caller's timeout aborts the request. Proves thread
    // open can never hang indefinitely on discovery.
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation timed out.', 'TimeoutError'));
          });
        })
    );

    const discover = createSuspendedRunDiscovery(resolveBaseUrl, fetchImpl, 20);
    const result = await discover('thread-1', 'workspace-1');

    expect(result).toEqual({ approvals: [], error: { reason: 'timed-out' }, suspends: [] });
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(logs.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('short-circuits to [] without a request when thread context is empty', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(makeResponse(200, { approvals: [] })));

    const discover = createSuspendedRunDiscovery(resolveBaseUrl, fetchImpl);
    expect(await discover('', 'workspace-1')).toEqual({ approvals: [], suspends: [] });
    expect(await discover('thread-1', '')).toEqual({ approvals: [], suspends: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('suspend() pause parsing (BST-1084)', () => {
  const resolveBaseUrl = (): Promise<string> => Promise.resolve('http://127.0.0.1:9999/');
  const suspend = {
    runId: 'run-suspend-1',
    stale: false,
    suspendedAt: '2026-08-01T10:00:00.000Z',
    suspendPayload: { question: 'Which region?' },
    toolCallId: 'call-suspend-1',
    toolName: 'brainstrike.askUser',
  };

  it('parses the additive suspends array alongside approvals', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(makeResponse(200, { approvals: [], suspends: [suspend] }))
    );
    const discover = createSuspendedRunDiscovery(resolveBaseUrl, fetchImpl);
    expect(await discover('thread-1', 'workspace-1')).toEqual({
      approvals: [],
      suspends: [suspend],
    });
  });

  it('treats an ABSENT suspends field (older server) as empty, never an error', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(makeResponse(200, { approvals: [] })));
    const discover = createSuspendedRunDiscovery(resolveBaseUrl, fetchImpl);
    expect(await discover('thread-1', 'workspace-1')).toEqual({ approvals: [], suspends: [] });
  });

  it('warns loudly on a PRESENT non-array suspends value instead of silently treating it as empty', async () => {
    const warnings: string[] = [];
    const removeListener = addLogListener((entry) => {
      if (entry.level === 'warn') {
        warnings.push(entry.message ?? '');
      }
    });
    try {
      const fetchImpl = vi.fn(() =>
        Promise.resolve(makeResponse(200, { approvals: [], suspends: 'not-an-array' }))
      );
      const discover = createSuspendedRunDiscovery(resolveBaseUrl, fetchImpl);
      expect(await discover('thread-1', 'workspace-1')).toEqual({
        approvals: [],
        error: { reason: 'invalid-response' },
        suspends: [],
      });
      expect(warnings.some((message) => /non-array suspends/i.test(message))).toBe(true);
    } finally {
      removeListener();
    }
  });

  it('drops a malformed suspend entry with a warning but keeps the valid ones', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        makeResponse(200, {
          approvals: [],
          // resumeSupported is ADVISORY: an unrecognized value must not drop
          // an otherwise-valid pause (that would re-create silent stranding).
          suspends: [{ runId: 'run-broken' }, suspend, { ...suspend, resumeSupported: true }],
        })
      )
    );
    const discover = createSuspendedRunDiscovery(resolveBaseUrl, fetchImpl);
    expect(await discover('thread-1', 'workspace-1')).toEqual({
      approvals: [],
      error: { reason: 'invalid-response' },
      suspends: [suspend, { ...suspend, resumeSupported: true }],
    });
  });
});
