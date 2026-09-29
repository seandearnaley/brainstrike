import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDeliverLiveDecision } from '../use-deliver-live-decision';

const snapshotMock = vi.hoisted(() => ({
  value: {
    enforce: true,
    policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
    sessionGrants: ['read'],
  } as Record<string, unknown>,
}));

vi.mock('@brainstrike/app-state/stores/permission-policy-store', () => ({
  getPermissionToolGateSnapshotInput: () => snapshotMock.value,
}));

vi.mock('../hooks/use-assistant-availability', async (importOriginal) => {
  const original = await importOriginal<typeof import('../hooks/use-assistant-availability')>();
  return {
    ...original,
    resolveAssistantAuthHeaders: vi.fn(async () => ({ 'x-test-auth': 'token-1' })),
    resolveAssistantBaseUrl: vi.fn(async () => 'http://127.0.0.1:9999'),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const action = {
  action: 'approve',
  delegation: {
    path: [
      {
        childRuntimeRunId: 'child-run',
        parentRuntimeRunId: 'root-run',
        parentToolCallId: 'delegate-1',
        personaId: 'explore',
      },
    ],
    toolCallId: 'leaf-1',
  },
  runId: 'root-run',
  toolCallId: 'delegate-1',
  toolName: 'brainstrike.grepSearch',
};
const message = {
  content: [{ text: 'Approved brainstrike.grepSearch.', type: 'text' as const }],
  metadata: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: action } },
  role: 'user' as const,
  runConfig: { custom: { [TOOL_APPROVAL_RUN_CONFIG_KEY]: action } },
  startRun: true,
};

describe('useDeliverLiveDecision', () => {
  it('POSTs the action, the live run id and the FRESH policy request to /assistant/decide', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ delivered: true, runId: 'run-9' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useDeliverLiveDecision(() => 'run-9', true));
    await expect(result.current(message)).resolves.toBe('delivered');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9999/assistant/decide');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-test-auth')).toBe('token-1');
    expect(JSON.parse(String(init.body))).toEqual({
      action,
      permissionPolicyRequest: snapshotMock.value,
      runId: 'run-9',
    });
  });

  it('omits the policy request when enforcement is off or not enforceable', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ delivered: true, runId: 'run-9' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useDeliverLiveDecision(() => 'run-9', false));
    await result.current(message);
    expect(
      JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    ).toEqual({ action, runId: 'run-9' });
    snapshotMock.value = { ...snapshotMock.value, enforce: false };
    const enforceable = renderHook(() => useDeliverLiveDecision(() => 'run-9', true));
    await enforceable.result.current(message);
    expect(
      JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))
    ).toEqual({ action, runId: 'run-9' });
  });

  it('reports no live run without fetching when no run is active, and on 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"no_live_run"}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const idle = renderHook(() => useDeliverLiveDecision(() => null, true));
    await expect(idle.result.current(message)).resolves.toBe('no-live-run');
    expect(fetchMock).not.toHaveBeenCalled();
    const { result } = renderHook(() => useDeliverLiveDecision(() => 'run-x', true));
    await expect(result.current(message)).resolves.toBe('no-live-run');
  });

  it('rejects with the host message on a refusal, and refuses a message without an action', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'decision_refused', message: 'already answered' }), {
          status: 409,
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useDeliverLiveDecision(() => 'run-x', true));
    await expect(result.current(message)).rejects.toThrow(/already answered/);
    await expect(
      result.current({ content: [{ text: 'hello', type: 'text' }], role: 'user' })
    ).rejects.toThrow(/requires a tool approval or resume action/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
