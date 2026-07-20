import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSteerActiveRun } from '../use-steer-active-run';

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

describe('useSteerActiveRun', () => {
  it('POSTs the active runId to /assistant/steer with auth headers and reports acceptance', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ accepted: true, runId: 'run-9' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSteerActiveRun(() => 'run-9'));
    await expect(result.current()).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9999/assistant/steer');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-test-auth')).toBe('token-1');
    expect(JSON.parse(String(init.body))).toEqual({ runId: 'run-9' });
  });

  it('resolves false without fetching when no run is active', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSteerActiveRun(() => null));
    await expect(result.current()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves false on 404 (run already finished) and throws on other failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"no_active_run"}', { status: 404 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSteerActiveRun(() => 'run-x'));
    await expect(result.current()).resolves.toBe(false);
    await expect(result.current()).rejects.toThrow(/500/);
  });
});
