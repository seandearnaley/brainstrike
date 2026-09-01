import { describe, expect, it, vi } from 'vitest';
import {
  McpAppFrameBridge,
  type McpAppFrameBridgeSnapshot,
  McpAppFrameRpcError,
} from '../src/index.js';
import { INITIALIZE, INITIALIZED, TestFrame, TestMessageTarget } from './frame-test-fixtures.js';

function expectQuiescent(snapshot: McpAppFrameBridgeSnapshot): void {
  expect(snapshot.pendingCallbacks).toBe(0);
  expect(snapshot.pendingInboundRequests).toBe(0);
  expect(snapshot.pendingOutboundRequests).toBe(0);
  expect(snapshot.pendingNotifications).toBe(0);
  expect(snapshot.timerCount).toBe(0);
}

async function completeHandshake(
  target: TestMessageTarget,
  frame: TestFrame,
  bridge: McpAppFrameBridge
): Promise<void> {
  target.dispatch(frame, INITIALIZE);
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
  expect(frame.sent.at(-1)?.message).toMatchObject({ id: 'initialize', result: {} });
  target.dispatch(frame, INITIALIZED);
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
  expect(bridge.snapshot.phase).toBe('ready');
}

function createBridge(options?: {
  readonly isGenerationLive?: (generation: number) => boolean;
  readonly onNotification?: ConstructorParameters<typeof McpAppFrameBridge>[0]['onNotification'];
  readonly onProtocolError?: (error: Error) => void;
  readonly onRequest?: ConstructorParameters<typeof McpAppFrameBridge>[0]['onRequest'];
  readonly timeoutMs?: number;
}): {
  readonly bridge: McpAppFrameBridge;
  readonly frame: TestFrame;
  readonly target: TestMessageTarget;
} {
  const target = new TestMessageTarget();
  const frame = new TestFrame();
  const bridge = new McpAppFrameBridge({
    eventTarget: target,
    isGenerationLive: options?.isGenerationLive ?? (() => true),
    onNotification: options?.onNotification ?? (async () => undefined),
    onProtocolError: options?.onProtocolError ?? (() => undefined),
    onRequest: options?.onRequest ?? (async () => ({})),
    timeoutMs: options?.timeoutMs ?? 1000,
  });
  bridge.connect({ generation: 1, origin: 'null', source: frame });
  return { bridge, frame, target };
}

describe('bounded MCP Apps iframe JSON-RPC bridge', () => {
  it('requires the Apps handshake before stable request and notification dispatch', async () => {
    const requests: string[] = [];
    const notifications: string[] = [];
    const { bridge, frame, target } = createBridge({
      onNotification: async (message) => {
        notifications.push(message.method);
      },
      onRequest: async (message) => {
        requests.push(message.method);
        return {};
      },
    });

    target.dispatch(frame, {
      id: 'early',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'too-early' },
    });
    expect(bridge.snapshot.phase).toBe('disconnected');
    expect(requests).toEqual([]);

    bridge.connect({ generation: 1, origin: 'null', source: frame });
    await completeHandshake(target, frame, bridge);
    target.dispatch(frame, {
      id: 'tool',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'refresh' },
    });
    target.dispatch(frame, {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { data: { ready: true }, level: 'info' },
    });

    await vi.waitFor(() => {
      expect(requests).toEqual(['ui/initialize', 'tools/call']);
      expect(notifications).toEqual(['ui/notifications/initialized', 'notifications/message']);
    });
    expectQuiescent(bridge.snapshot);
  });

  it('never invokes duplicate asynchronous initialize or initialized callbacks', async () => {
    const initializeCallbacks: Array<() => void> = [];
    const initializedCallbacks: Array<() => void> = [];
    const errors: Error[] = [];
    const first = createBridge({
      onProtocolError: (error) => errors.push(error),
      onRequest: async (message) => {
        if (message.method !== 'ui/initialize') {
          return {};
        }
        await new Promise<void>((resolve) => initializeCallbacks.push(resolve));
        return {};
      },
    });

    first.target.dispatch(first.frame, INITIALIZE);
    await vi.waitFor(() => expect(initializeCallbacks).toHaveLength(1));
    first.target.dispatch(first.frame, INITIALIZE);
    expect(initializeCallbacks).toHaveLength(1);
    expect(first.bridge.snapshot.phase).toBe('disconnected');

    const second = createBridge({
      onNotification: async (message) => {
        if (message.method === 'ui/notifications/initialized') {
          await new Promise<void>((resolve) => initializedCallbacks.push(resolve));
        }
      },
      onProtocolError: (error) => errors.push(error),
    });
    second.target.dispatch(second.frame, INITIALIZE);
    await vi.waitFor(() => expect(second.bridge.snapshot.phase).toBe('awaiting-initialized'));
    second.target.dispatch(second.frame, INITIALIZED);
    await vi.waitFor(() => expect(initializedCallbacks).toHaveLength(1));
    second.target.dispatch(second.frame, INITIALIZED);
    expect(initializedCallbacks).toHaveLength(1);
    expect(second.bridge.snapshot.phase).toBe('disconnected');
    expect(errors.map((error) => error.message)).toEqual([
      'MCP Apps frame sent traffic while ui/initialize is pending',
      'MCP Apps frame sent traffic while ui/notifications/initialized is pending',
    ]);
  });

  it('correlates type-sensitive outbound ids and safe explicit RPC errors', async () => {
    const { bridge, frame, target } = createBridge({
      onRequest: async (message) => {
        if (message.method === 'ui/open-link') {
          throw new McpAppFrameRpcError(-32_001, 'Link denied', { policy: 'blocked' });
        }
        return {};
      },
    });
    await completeHandshake(target, frame, bridge);

    const numeric = bridge.sendRequest({
      id: 1,
      jsonrpc: '2.0',
      method: 'ui/resource-teardown',
      params: {},
    });
    const textual = bridge.sendRequest({
      id: '1',
      jsonrpc: '2.0',
      method: 'ui/resource-teardown',
      params: {},
    });
    target.dispatch(frame, { id: '1', jsonrpc: '2.0', result: { kind: 'text' } });
    target.dispatch(frame, { id: 1, jsonrpc: '2.0', result: { kind: 'number' } });
    await expect(textual).resolves.toEqual({ kind: 'text' });
    await expect(numeric).resolves.toEqual({ kind: 'number' });

    target.dispatch(frame, {
      id: 'denied',
      jsonrpc: '2.0',
      method: 'ui/open-link',
      params: { url: 'https://example.com' },
    });
    await vi.waitFor(() =>
      expect(frame.sent.at(-1)?.message).toEqual({
        error: { code: -32_001, data: { policy: 'blocked' }, message: 'Link denied' },
        id: 'denied',
        jsonrpc: '2.0',
      })
    );
    expectQuiescent(bridge.snapshot);
  });

  it('bounds notifications before callback allocation and fails quiescent at cap plus one', async () => {
    vi.useFakeTimers();
    try {
      let callbacks = 0;
      const { bridge, frame, target } = createBridge({
        onNotification: async (message, context) => {
          if (message.method === 'ui/notifications/initialized') {
            return;
          }
          callbacks += 1;
          await new Promise<void>((_, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason), {
              once: true,
            });
          });
        },
      });
      await completeHandshake(target, frame, bridge);
      const notification = {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { data: { pending: true }, level: 'info' },
      };

      for (let index = 0; index < 255; index += 1) {
        target.dispatch(frame, notification);
      }
      expect(bridge.snapshot.pendingNotifications).toBe(255);
      target.dispatch(frame, notification);
      expect(bridge.snapshot.pendingNotifications).toBe(256);
      target.dispatch(frame, notification);

      expect(callbacks).toBe(0);
      expect(bridge.snapshot.phase).toBe('disconnected');
      expect(bridge.snapshot.listenerCount).toBe(0);
      expectQuiescent(bridge.snapshot);
      await Promise.resolve();
      expect(callbacks).toBe(0);
      expectQuiescent(bridge.snapshot);
    } finally {
      vi.useRealTimers();
    }
  });

  it('owns timeout, cancellation, replacement, disconnect, and close cleanup', async () => {
    vi.useFakeTimers();
    try {
      const target = new TestMessageTarget();
      const first = new TestFrame();
      const second = new TestFrame();
      const bridge = new McpAppFrameBridge({
        eventTarget: target,
        isGenerationLive: () => true,
        onNotification: async (message) =>
          message.method === 'ui/notifications/initialized'
            ? undefined
            : await new Promise(() => undefined),
        onProtocolError: () => undefined,
        onRequest: async (message, context) => {
          if (message.method === 'ui/initialize') {
            return {};
          }
          return await new Promise((_, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason), {
              once: true,
            });
          });
        },
        timeoutMs: 50,
      });
      bridge.connect({ generation: 1, origin: 'null', source: first });
      await completeHandshake(target, first, bridge);

      const timedOut = bridge.sendRequest({
        id: 'timeout',
        jsonrpc: '2.0',
        method: 'ui/resource-teardown',
        params: {},
      });
      const timedOutAssertion = expect(timedOut).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(51);
      await timedOutAssertion;

      const controller = new AbortController();
      first.onPost = () => {
        first.onPost = undefined;
        controller.abort(new Error('caller cancelled'));
      };
      await expect(
        bridge.sendRequest(
          { id: 'cancelled', jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} },
          { signal: controller.signal }
        )
      ).rejects.toThrow(/caller cancelled/);

      target.dispatch(first, {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { data: { wait: true }, level: 'info' },
      });
      target.dispatch(first, {
        id: 'inbound',
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'wait' },
      });
      expect(bridge.snapshot.pendingCallbacks).toBe(2);
      bridge.replace({ generation: 2, origin: 'null', source: second });
      expect(bridge.snapshot.phase).toBe('awaiting-initialize');
      expectQuiescent(bridge.snapshot);

      await completeHandshake(target, second, bridge);
      bridge.disconnect();
      expect(bridge.snapshot.listenerCount).toBe(0);
      expectQuiescent(bridge.snapshot);
      bridge.connect({ generation: 3, origin: 'null', source: first });
      bridge.close();
      expect(bridge.snapshot.phase).toBe('closed');
      expect(target.listeners.size).toBe(0);
      expectQuiescent(bridge.snapshot);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed on malformed, unknown, replayed, or unsendable traffic', async () => {
    for (const failure of [
      { id: 'bad', jsonrpc: '1.0', method: 'ping' },
      { id: 'unknown', jsonrpc: '2.0', method: 'tools/list', params: {} },
    ]) {
      const current = createBridge();
      await completeHandshake(current.target, current.frame, current.bridge);
      current.target.dispatch(current.frame, failure);
      expect(current.bridge.snapshot.phase).toBe('disconnected');
      expectQuiescent(current.bridge.snapshot);
    }

    const replay = createBridge();
    await completeHandshake(replay.target, replay.frame, replay.bridge);
    replay.target.dispatch(replay.frame, { id: 'replay', jsonrpc: '2.0', method: 'ping' });
    await vi.waitFor(() => expectQuiescent(replay.bridge.snapshot));
    replay.target.dispatch(replay.frame, { id: 'replay', jsonrpc: '2.0', method: 'ping' });
    expect(replay.bridge.snapshot.phase).toBe('disconnected');

    const unsendable = createBridge();
    await completeHandshake(unsendable.target, unsendable.frame, unsendable.bridge);
    unsendable.frame.throwOnPost = new Error('frame detached');
    expect(() =>
      unsendable.bridge.sendNotification({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-input',
        params: {},
      })
    ).toThrow(/frame detached/);
    expect(unsendable.bridge.snapshot.phase).toBe('disconnected');
    expectQuiescent(unsendable.bridge.snapshot);
  });
});
