import { BoundaryFailureError, fault } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { ResponseError } from 'vscode-jsonrpc';
import type { HostProviderService } from '../src/ports.js';
import type { HostMethod } from '../src/protocol.js';
import { bindHostProviderMethods } from '../src/provider-connection.js';

type Bound = (params: unknown, signal?: AbortSignal) => unknown;
function bound(
  providers: HostProviderService | undefined,
  origin: 'desktop-ui' | 'public-socket'
): Map<HostMethod, Bound> {
  const handlers = new Map<HostMethod, Bound>();
  bindHostProviderMethods(
    (method, request) => {
      handlers.set(method, request as Bound);
    },
    providers,
    origin
  );
  return handlers;
}

describe('host provider methods', () => {
  it("passes the connection's origin to verification and returns the host's answers", async () => {
    const snapshot = {
      freshness: 'live' as const,
      result: { checkedAt: '2026-10-08T00:00:00.000Z', status: 'verified' as const },
    };
    const providers: HostProviderService = {
      openRouterModel: vi.fn(),
      status: vi.fn(async () => ({ enabled: true, providers: ['local'] })),
      verify: vi.fn(async () => snapshot),
    };
    const handlers = bound(providers, 'public-socket');

    await expect(handlers.get('host/status')?.({})).resolves.toEqual({
      enabled: true,
      providers: ['local'],
    });
    const { signal } = new AbortController();
    await expect(handlers.get('providers/verify')?.({ provider: 'openai' }, signal)).resolves.toBe(
      snapshot
    );
    expect(providers.verify).toHaveBeenCalledWith('openai', 'public-socket', signal);
  });

  it("keeps a typed failure's type: a request cancelled as closing answers host.closing", async () => {
    const closing = new BoundaryFailureError(
      fault({ category: 'availability', code: 'host.closing', message: 'Closing.' })
    );
    const providers: HostProviderService = {
      openRouterModel: vi.fn(async () => {
        throw closing;
      }),
      status: vi.fn(),
      verify: vi.fn(async () => {
        throw closing;
      }),
    };
    const handlers = bound(providers, 'public-socket');
    const { signal } = new AbortController();

    await expect(handlers.get('providers/verify')?.({ provider: 'openai' }, signal)).rejects.toBe(
      closing
    );
    await expect(
      handlers.get('providers/openrouter-model')?.({ model: 'openai/gpt-5.4-mini' }, signal)
    ).rejects.toBe(closing);
    expect(providers.openRouterModel).toHaveBeenCalledWith('openai/gpt-5.4-mini', signal);
  });

  it('crosses a failure as its own text, without the transport prefix', async () => {
    const providers: HostProviderService = {
      openRouterModel: vi.fn(async () => {
        throw new Error('No API key configured for provider "openrouter".');
      }),
      status: vi.fn(),
      verify: vi.fn(),
    };
    const failure = bound(providers, 'desktop-ui').get('providers/openrouter-model')?.({
      model: 'anthropic/claude-sonnet-4.6',
    });

    await expect(failure).rejects.toBeInstanceOf(ResponseError);
    await expect(failure).rejects.toThrow(/^No API key configured for provider "openrouter"\.$/);
  });

  it('refuses every provider read on a host that owns no credential store', async () => {
    await expect(bound(undefined, 'desktop-ui').get('host/status')?.({})).rejects.toThrow(
      'This host owns no provider services'
    );
  });
});
