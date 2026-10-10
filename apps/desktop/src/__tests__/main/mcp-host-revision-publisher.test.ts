import type { ConfiguredMcpServerId, McpHostServerSnapshot } from '@brainstrike/assistant-contract';
import {
  McpHostRevisionPublisher,
  McpHostRevisionPublisherTransitionError,
} from '@brainstrike/host-capabilities/mcp/host-revision-publisher';
import { describe, expect, it, vi } from 'vitest';

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

  it('rejects stale and future actor generations without mutating authority', () => {
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
    publisher.publishConfigSet([server('alpha', 2)]);

    expect(() => publisher.publishActorTransition(server('alpha', 0))).toThrowError(
      expect.objectContaining({ category: 'generation-retired', code: 'mcp-host-stale-generation' })
    );
    expect(() => publisher.publishActorTransition(server('alpha', 3))).toThrowError(
      expect.objectContaining({
        category: 'generation-retired',
        code: 'mcp-host-future-generation',
      })
    );
    expect(publisher.snapshot()).toEqual({ revision: 1, servers: [server('alpha', 2)] });
  });

  it('rejects unknown servers and actor attempts to mutate config-owned policy', () => {
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
    publisher.publishConfigSet([server('alpha')]);

    expect(() => publisher.publishActorTransition(server('missing'))).toThrowError(
      new McpHostRevisionPublisherTransitionError('mcp-host-server-unknown', 'missing')
    );
    expect(() =>
      publisher.publishActorTransition({ ...server('alpha'), configuredProtocol: 'legacy' })
    ).toThrowError(expect.objectContaining({ code: 'mcp-host-actor-config-mismatch' }));
    expect(() =>
      publisher.publishActorTransition({ ...server('alpha'), transport: 'stdio' })
    ).toThrowError(expect.objectContaining({ code: 'mcp-host-actor-config-mismatch' }));
    expect(publisher.snapshot()).toEqual({ revision: 1, servers: [server('alpha')] });
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
    const returned = publisher.publishConfigSet([input]);
    Reflect.set(input, 'generation', 42);
    Reflect.set(returned.servers[0] ?? {}, 'generation', 77);
    await flush();

    expect(diagnostic).toHaveBeenCalledWith(
      {
        code: 'mcp-host-watch-listener-failed',
        message: 'MCP host watch listener failed',
      },
      listenerFailure
    );
    expect(safeListener).toHaveBeenCalledWith({ revision: 1, servers: [server('alpha')] });
    expect(safeListener.mock.lastCall?.[0]).not.toBe(returned);
    expect(unsubscribed).not.toHaveBeenCalled();
    expect(structuredClone(publisher.snapshot())).toEqual({
      revision: 1,
      servers: [server('alpha')],
    });
  });

  it('does not advance authority when event detachment fails', () => {
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
    const cloneValue = globalThis.structuredClone;
    let calls = 0;
    const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation(<T>(value: T): T => {
      calls += 1;
      if (calls === 2) {
        throw new Error('event clone failed');
      }
      return cloneValue(value);
    });

    try {
      expect(() => publisher.publishConfigSet([server('alpha')])).toThrow('event clone failed');
    } finally {
      clone.mockRestore();
    }
    expect(publisher.snapshot()).toEqual({ revision: 0, servers: [] });
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

  it('rejects empty filters but permits a future configured server id', async () => {
    const listener = vi.fn();
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
    expect(() => publisher.watch({ configuredServerIds: [] }, listener)).toThrowError(
      expect.objectContaining({ code: 'mcp-host-empty-watch-filter' })
    );
    publisher.watch({ configuredServerIds: [server('future').configuredServerId] }, listener);
    publisher.publishConfigSet([server('future')]);
    await flush();
    expect(listener).toHaveBeenCalledWith({ revision: 1, servers: [server('future')] });
  });

  it('invalidates queued registrations and rejects watches after terminal close', async () => {
    const listener = vi.fn();
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
    publisher.watch({}, listener);
    publisher.publishConfigSet([server('alpha')]);
    expect(publisher.close()).toBe(1);
    expect(publisher.close()).toBe(0);
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

  it('accounts for a disposed registration once without retaining its queued callback', async () => {
    const listener = vi.fn();
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
    const unsubscribe = publisher.watch({}, listener);
    publisher.publishConfigSet([server('alpha')]);
    unsubscribe();
    unsubscribe();
    await flush();

    expect(listener).not.toHaveBeenCalled();
    expect(publisher.close()).toBe(1);
    unsubscribe();
    expect(publisher.close()).toBe(0);
  });

  it('accounts for retired and active registrations without double-counting terminal disposal', () => {
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
    const retired = publisher.watch({}, vi.fn());
    const active = publisher.watch({}, vi.fn());
    retired();
    retired();

    expect(publisher.close()).toBe(2);
    active();
    retired();
    expect(publisher.close()).toBe(0);
  });

  it('counts both real detach/reopen registrations while preserving revision fencing', async () => {
    const publisher = new McpHostRevisionPublisher({ onDiagnostic: vi.fn() });
    const oldListener = vi.fn();
    const oldUnsubscribe = publisher.watch({}, oldListener);
    publisher.publishConfigSet([server('alpha')]);
    oldUnsubscribe();
    const newListener = vi.fn();
    const newUnsubscribe = publisher.watch({}, newListener);
    await flush();

    expect(oldListener).not.toHaveBeenCalled();
    expect(newListener).not.toHaveBeenCalled();
    publisher.publishConfigSet([]);
    await flush();
    expect(newListener).toHaveBeenCalledOnce();
    expect(newListener).toHaveBeenCalledWith({ revision: 2, servers: [] });
    newUnsubscribe();

    expect(publisher.close()).toBe(2);
    expect(publisher.close()).toBe(0);
  });
});
