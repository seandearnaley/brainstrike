import { StateStoreReadOnlyError } from '@brainstrike/state-store';
import { describe, expect, it, vi } from 'vitest';
import { type MessageConnection, ResponseError } from 'vscode-jsonrpc';
import type { HostMethodHandler } from '../src/auth-connection.js';
import { bindHostMcpPresentationMethods } from '../src/mcp-presentation-connection.js';
import type { HostClientOrigin, HostMcpPresentationService } from '../src/ports.js';
import type { HostMethod } from '../src/protocol.js';

function bound(service: HostMcpPresentationService, origin: HostClientOrigin) {
  const handlers = new Map<HostMethod, (params: unknown) => Promise<unknown>>();
  const handle: HostMethodHandler = (method, request) => {
    handlers.set(method, request as (params: unknown) => Promise<unknown>);
  };
  const binding = bindHostMcpPresentationMethods(
    handle,
    {
      dispose: vi.fn(),
      sendNotification: vi.fn(async () => undefined),
    } as unknown as MessageConnection,
    service,
    origin
  );
  return { binding, handlers };
}

function service(): HostMcpPresentationService {
  return {
    act: vi.fn(async () => ({
      diagnostic: { code: 'stale_handle' as const, message: 'Task is gone' },
      ok: false as const,
    })),
    settle: vi.fn(async () => undefined),
    subscribe: vi.fn(() => vi.fn()),
    tasks: vi.fn(() => ({ tasks: [] })),
  };
}

/** BST-1930 c5c: a task card's actions and a server input's answer are the desktop user's. */
describe('host MCP presentation methods', () => {
  it("serves the desktop's private client and streams its presentations", async () => {
    const owner = service();
    const { binding, handlers } = bound(owner, 'desktop-ui');

    await expect(handlers.get('mcp/presentation/subscribe')?.({})).resolves.toEqual({ tasks: [] });
    await expect(handlers.get('mcp/tasks/list')?.({})).resolves.toEqual({ tasks: [] });
    await expect(handlers.get('mcp/elicitation/settle')?.({})).resolves.toEqual({ settled: true });
    expect(owner.subscribe).toHaveBeenCalledOnce();
    binding.dispose();
  });

  it('refuses every presentation method to a public-socket client', async () => {
    const owner = service();
    const { handlers } = bound(owner, 'public-socket');

    for (const method of [
      'mcp/presentation/subscribe',
      'mcp/tasks/list',
      'mcp/tasks/act',
      'mcp/elicitation/settle',
    ] as const) {
      await expect(handlers.get(method)?.({})).rejects.toThrow(
        "MCP presentations are available only to the desktop's private client"
      );
    }
    expect(owner.subscribe).not.toHaveBeenCalled();
    expect(owner.act).not.toHaveBeenCalled();
    expect(owner.settle).not.toHaveBeenCalled();
  });

  it("keeps a read-only state store's refusal typed, and shows any other failure as written (BST-2144)", async () => {
    const owner = service();
    vi.mocked(owner.act)
      .mockRejectedValueOnce(new StateStoreReadOnlyError('row 1 missing from index'))
      .mockRejectedValueOnce(new Error('Task handle is stale'));
    const { handlers } = bound(owner, 'desktop-ui');

    await expect(handlers.get('mcp/tasks/act')?.({})).rejects.toMatchObject({
      failure: { code: 'state.read-only', kind: 'refusal' },
    });
    const other = await handlers
      .get('mcp/tasks/act')?.({})
      .catch((cause: unknown) => cause);
    expect(other).toBeInstanceOf(ResponseError);
    expect(other).toMatchObject({ message: 'Task handle is stale' });
  });
});
