import type { ConfiguredMcpServerId, McpHostServerSnapshot } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { McpHostRevisionPublisher } from '../../mcp/host-revision-publisher';

const server = (id: string, generation = 1): McpHostServerSnapshot => ({
  configuredProtocol: 'auto',
  configuredServerId: id as ConfiguredMcpServerId,
  generation,
  state: 'disconnected',
  transport: 'streamable-http',
});

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
};

describe('McpHostRevisionPublisher', () => {
  it('owns revision zero and publishes deterministically ordered config revisions', async () => {
    const listener = vi.fn();
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
    publisher.watch({}, listener);

    expect(publisher.snapshot()).toEqual({ revision: 0, servers: [] });
    expect(publisher.publishConfigSet([server('zeta'), server('alpha')])).toEqual({
      revision: 1,
      servers: [server('alpha'), server('zeta')],
    });
    expect(publisher.publishConfigSet([server('alpha'), server('zeta')]).revision).toBe(1);
    await flush();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      revision: 1,
      servers: [server('alpha'), server('zeta')],
    });
  });

  it('separates config and actor revisions while omitting queued history', async () => {
    const listener = vi.fn();
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
    expect(publisher.publishConfigSet([server('alpha')]).revision).toBe(1);
    publisher.watch({}, listener);

    expect(
      publisher.publishActorTransition({ ...server('alpha'), state: 'connecting' }).revision
    ).toBe(2);
    expect(
      publisher.publishActorTransition({ ...server('alpha'), state: 'connecting' }).revision
    ).toBe(2);
    expect(
      publisher.publishActorTransition({ ...server('alpha'), state: 'closing' }).revision
    ).toBe(3);
    await flush();

    expect(listener.mock.calls.map(([event]) => event.revision)).toEqual([2, 3]);
  });

  it('delivers filtered removals and empty config snapshots with revision holes', async () => {
    const alphaListener = vi.fn();
    const allListener = vi.fn();
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
    publisher.publishConfigSet([server('alpha'), server('beta')]);
    await flush();
    publisher.watch({ configuredServerIds: [server('alpha').configuredServerId] }, alphaListener);
    publisher.watch({}, allListener);

    publisher.publishActorTransition({ ...server('beta'), state: 'connecting' });
    publisher.publishConfigSet([server('beta', 2)]);
    publisher.publishConfigSet([]);
    await flush();

    expect(alphaListener.mock.calls.map(([event]) => event)).toEqual([
      { revision: 3, servers: [] },
    ]);
    expect(allListener.mock.calls.map(([event]) => event.revision)).toEqual([2, 3, 4]);
    expect(allListener.mock.lastCall?.[0]).toEqual({ revision: 4, servers: [] });
  });

  it('detaches values, isolates listener failures, and honors unsubscribe before flush', async () => {
    const listenerFailure = new Error('Authorization: Bearer secret-value');
    const diagnostic = vi.fn(() => {
      throw new Error('diagnostic unavailable');
    });
    const safeListener = vi.fn();
    const unsubscribed = vi.fn();
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: diagnostic });
    publisher.watch({}, () => {
      throw listenerFailure;
    });
    publisher.watch({}, (event) => {
      Reflect.set(event.servers[0] ?? {}, 'generation', 99);
    });
    publisher.watch({}, safeListener);
    const unsubscribe = publisher.watch({}, unsubscribed);
    unsubscribe();
    unsubscribe();

    const input = server('alpha');
    publisher.publishConfigSet([input]);
    Reflect.set(input, 'generation', 42);
    await flush();

    expect(diagnostic).toHaveBeenCalledWith(
      {
        code: 'mcp-host-watch-listener-failed',
        message: 'MCP host watch listener failed',
      },
      listenerFailure
    );
    expect(safeListener).toHaveBeenCalledWith({ revision: 1, servers: [server('alpha')] });
    expect(unsubscribed).not.toHaveBeenCalled();
    expect(structuredClone(publisher.snapshot())).toEqual({
      revision: 1,
      servers: [server('alpha')],
    });
  });

  it('isolates asynchronous listener rejections through the diagnostic sink', async () => {
    const listenerFailure = new Error('Authorization: Bearer secret-value');
    const diagnostic = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('diagnostic sink unavailable');
    });
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: diagnostic });
    publisher.watch({}, async () => {
      await Promise.resolve();
      throw listenerFailure;
    });

    publisher.publishConfigSet([server('alpha')]);
    await flush();
    await flush();

    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(
      {
        code: 'mcp-host-watch-listener-failed',
        message: 'MCP host watch listener failed',
      },
      listenerFailure
    );
  });

  it('invalidates queued registrations and rejects watches after terminal close', async () => {
    const listener = vi.fn();
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
    publisher.watch({}, listener);
    publisher.publishConfigSet([server('alpha')]);
    publisher.close();
    publisher.close();
    await flush();

    expect(listener).not.toHaveBeenCalled();
    expect(() => publisher.publishConfigSet([])).toThrowError('MCP host is closed');
    expect(() => publisher.watch({}, vi.fn())).toThrowError(
      expect.objectContaining({
        category: 'host-closed',
        code: 'mcp-host-closed',
        message: 'MCP host is closed',
      })
    );
  });
});
