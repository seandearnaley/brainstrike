import { SUBSCRIPTION_ID_META_KEY, type Transport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  McpClientExtensionRegistry,
  REGISTERED_EXTENSION_RESULT_KEY,
} from '../mcp/client-extension-registry';
import {
  applyRegisteredExtensionHttpHeaders,
  encodeMcpHeaderValue,
  installRegisteredExtensionDispatch,
  RegisteredExtensionDispatchLedger,
} from '../mcp/registered-extension-dispatch';
import {
  MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT,
  registerMcpTasksWireContracts,
} from '../mcp/tasks-extension';
import {
  createDeferredTestExtension,
  TEST_EXTENSION_REQUEST,
} from './fixtures/mcp-client-extension-registry';

function registeredRegistry() {
  const extension = createDeferredTestExtension();
  extension.register();
  return extension.registry;
}

function registryWithoutMcpName(): McpClientExtensionRegistry {
  const registry = new McpClientExtensionRegistry();
  const settings = { mode: 'strict' } as const;
  const implementation = { ready: true } as const;
  registry.register(
    {
      id: 'com.example/no-name-host',
      isCompleteImplementation: (value): value is typeof implementation => value === implementation,
      isServerSettingsCompatible: (client, server) => client.mode === server.mode,
      parseServerSettings: (value) => z.strictObject({ mode: z.literal('strict') }).parse(value),
      parseSettings: (value) => z.strictObject({ mode: z.literal('strict') }).parse(value),
      requests: [
        {
          method: 'tasks/update',
          paramsSchema: z.strictObject({ taskId: z.string().min(1) }),
          protocol: '2026-07-28',
          resultSchema: z.strictObject({ accepted: z.boolean() }),
        },
      ],
      version: '2026-08-29',
    },
    { implementation, settings, version: '2026-08-29' }
  );
  return registry;
}

describe('registered extension HTTP dispatch', () => {
  it('isolates pending extension results by transport when request IDs collide', async () => {
    const registry = new McpClientExtensionRegistry();
    registerMcpTasksWireContracts(registry);
    const prepared = await registry.prepareRequest(
      MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT,
      { arguments: {}, name: 'deferred-tool' },
      { 'io.modelcontextprotocol/tasks': {} },
      '2026-07-28'
    );
    const createTransport = () =>
      installRegisteredExtensionDispatch(
        {
          close: vi.fn(async () => undefined),
          send: vi.fn(async () => undefined),
          start: vi.fn(async () => undefined),
        } as unknown as Transport,
        registry
      );
    const first = createTransport();
    const second = createTransport();
    const seen: unknown[] = [];
    first.onmessage = (message) => seen.push(message);
    second.onmessage = (message) => seen.push(message);
    const request = {
      id: 0,
      jsonrpc: '2.0' as const,
      method: prepared.internalMethod,
      params: prepared.params,
    };
    await first.send(request);
    await second.send(request);
    const result = { resultType: 'task', taskId: 'task-123' };
    first.onmessage?.({ id: 0, jsonrpc: '2.0', result });
    second.onmessage?.({ id: 0, jsonrpc: '2.0', result });
    expect(seen).toHaveLength(2);
    expect(seen).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({ [REGISTERED_EXTENSION_RESULT_KEY]: result }),
      }),
      expect.objectContaining({
        result: expect.objectContaining({ [REGISTERED_EXTENSION_RESULT_KEY]: result }),
      }),
    ]);
  });

  it('releases a pending extension result type on local cancellation and on close', async () => {
    // Review of #2913: entries were removed only by a matching response, so a
    // timed-out or aborted task request leaked for the life of the transport.
    const registry = new McpClientExtensionRegistry();
    registerMcpTasksWireContracts(registry);
    const prepared = await registry.prepareRequest(
      MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT,
      { arguments: {}, name: 'deferred-tool' },
      { 'io.modelcontextprotocol/tasks': {} },
      '2026-07-28'
    );
    const innerClose = vi.fn(async () => undefined);
    const transport = installRegisteredExtensionDispatch(
      {
        close: innerClose,
        send: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
      } as unknown as Transport,
      registry
    );
    const seen: unknown[] = [];
    transport.onmessage = (message) => seen.push(message);
    const request = (id: number) => ({
      id,
      jsonrpc: '2.0' as const,
      method: prepared.internalMethod,
      params: prepared.params,
    });
    const result = { resultType: 'task', taskId: 'task-123' };

    await transport.send(request(1));
    await transport.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { reason: 'timeout', requestId: 1 },
    });
    transport.onmessage?.({ id: 1, jsonrpc: '2.0', result });

    await transport.send(request(2));
    await transport.close();
    expect(innerClose).toHaveBeenCalledTimes(1);
    transport.onmessage?.({ id: 2, jsonrpc: '2.0', result });

    expect(seen).toHaveLength(2);
    for (const message of seen) {
      expect(message).toEqual({ id: expect.any(Number), jsonrpc: '2.0', result });
    }
  });

  it('clears only the closing transport entries from a client-scoped ledger', async () => {
    // Review of #2928: the HTTP client builds ONE ledger per client and installs
    // it on every transport it creates, so an old transport's close must not wipe
    // a live transport's in-flight dispatch or its bound subscription claim.
    const registry = new McpClientExtensionRegistry();
    registerMcpTasksWireContracts(registry);
    const prepared = await registry.prepareRequest(
      MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT,
      { arguments: {}, name: 'deferred-tool' },
      { 'io.modelcontextprotocol/tasks': {} },
      '2026-07-28'
    );
    const ledger = new RegisteredExtensionDispatchLedger();
    const createTransport = (send: Transport['send']) =>
      installRegisteredExtensionDispatch(
        {
          close: vi.fn(async () => undefined),
          send,
          start: vi.fn(async () => undefined),
        } as unknown as Transport,
        registry,
        ledger
      );
    const closing = createTransport(vi.fn(async () => undefined));
    const liveSend = Promise.withResolvers<void>();
    const live = createTransport(
      vi.fn(async (message) => {
        if ('method' in message && message.method === 'tools/call') {
          await liveSend.promise;
        }
      })
    );
    closing.onmessage = () => undefined;
    live.onmessage = () => undefined;

    const filter = { taskIds: ['task-live'] };
    const capture = ledger.captureSubscriptionAcknowledgement(filter);
    await live.send({
      id: 9,
      jsonrpc: '2.0',
      method: 'subscriptions/listen',
      params: { notifications: filter },
    });
    const inFlight = live.send({
      id: 11,
      jsonrpc: '2.0',
      method: prepared.internalMethod,
      params: prepared.params,
    });
    expect(ledger.hasDispatchedRequest(11)).toBe(true);

    await closing.close();

    expect(ledger.hasDispatchedRequest(11)).toBe(true);
    live.onmessage?.({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: {
        _meta: { [SUBSCRIPTION_ID_META_KEY]: '9' },
        notifications: { taskIds: ['task-live'] },
      },
    });
    expect(capture.acknowledged).toBe(true);
    expect(capture.acknowledgement).toEqual({ taskIds: ['task-live'] });

    liveSend.resolve();
    await inFlight;
    expect(ledger.hasDispatchedRequest(11)).toBe(false);
    await live.close();
    expect(ledger.hasDispatchedRequest(11)).toBe(false);
  });

  it('reports rewrite failures through the transport promise', async () => {
    const transport = {
      close: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
    } as unknown as Transport;
    const registry = {
      rewriteOutgoingMessage: () => {
        throw new Error('rewrite rejected');
      },
    } as unknown as McpClientExtensionRegistry;
    const wrapped = installRegisteredExtensionDispatch(transport, registry);

    await expect(
      wrapped.send({ id: 1, jsonrpc: '2.0', method: 'tasks/get', params: {} })
    ).rejects.toThrow('rewrite rejected');
  });

  it('keeps incoming rewriting installed across SDK handler reassignment', async () => {
    const registry = new McpClientExtensionRegistry();
    registerMcpTasksWireContracts(registry);
    const prepared = await registry.prepareRequest(
      MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT,
      { arguments: {}, name: 'deferred-tool' },
      { 'io.modelcontextprotocol/tasks': {} },
      '2026-07-28'
    );
    const wrapped = installRegisteredExtensionDispatch(
      {
        close: vi.fn(async () => undefined),
        send: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
      } as unknown as Transport,
      registry
    );
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    wrapped.onmessage = firstHandler;
    await wrapped.send({
      id: 1,
      jsonrpc: '2.0',
      method: prepared.internalMethod,
      params: prepared.params,
    });
    wrapped.onmessage = secondHandler;
    wrapped.onmessage?.({
      id: 1,
      jsonrpc: '2.0',
      result: { resultType: 'task', taskId: 'task-123' },
    });

    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          [REGISTERED_EXTENSION_RESULT_KEY]: expect.objectContaining({ taskId: 'task-123' }),
        }),
      }),
      undefined
    );
  });

  it('fails visibly when a message arrives before the SDK installs its handler', () => {
    const wrapped = installRegisteredExtensionDispatch(
      {
        close: vi.fn(async () => undefined),
        send: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
      } as unknown as Transport,
      registeredRegistry()
    );

    expect(() => wrapped.onmessage?.({ jsonrpc: '2.0', method: 'notifications/example' })).toThrow(
      'before its SDK handler was registered'
    );
  });

  it('encodes only header values that cannot be sent literally', () => {
    expect(encodeMcpHeaderValue('task-123')).toBe('task-123');
    expect(encodeMcpHeaderValue('tâsk-雪')).toBe('=?base64?dMOic2st6Zuq?=');
    expect(encodeMcpHeaderValue('')).toBe('=?base64??=');
    expect(encodeMcpHeaderValue(' task-123')).toBe('=?base64?IHRhc2stMTIz?=');
  });

  it.each([undefined, 'not-json', new Uint8Array([1, 2, 3])])(
    'rejects an unreadable body carrying a registered extension method header',
    (body) => {
      expect(() =>
        applyRegisteredExtensionHttpHeaders(
          {
            ...(body === undefined ? {} : { body }),
            headers: { 'mcp-method': TEST_EXTENSION_REQUEST.method },
            method: 'POST',
          },
          registeredRegistry()
        )
      ).toThrow(/registered MCP extension request body/iu);
    }
  );

  it('rejects a registered extension body whose method header is missing', () => {
    expect(() =>
      applyRegisteredExtensionHttpHeaders(
        {
          body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: TEST_EXTENSION_REQUEST.method,
            params: { taskId: 'task-123' },
          }),
          method: 'POST',
        },
        registeredRegistry()
      )
    ).toThrow('method/header mismatch');
  });

  it('accepts an agreeing Mcp-Name and rejects transport header drift', () => {
    const request = {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: TEST_EXTENSION_REQUEST.method,
        params: { taskId: 'task-123' },
      }),
      headers: {
        'mcp-method': TEST_EXTENSION_REQUEST.method,
        'mcp-name': 'task-123',
      },
      method: 'POST',
    };
    expect(
      new Headers(applyRegisteredExtensionHttpHeaders(request, registeredRegistry())?.headers).get(
        'mcp-name'
      )
    ).toBe('task-123');
    expect(() =>
      applyRegisteredExtensionHttpHeaders(
        { ...request, headers: { ...request.headers, 'mcp-name': 'different-task' } },
        registeredRegistry()
      )
    ).toThrow('Mcp-Name mismatch');
  });

  it('passes a core tools/call through untouched when Tasks shares the wire method', () => {
    const registry = new McpClientExtensionRegistry();
    registerMcpTasksWireContracts(registry);
    const init = {
      body: JSON.stringify({
        id: 7,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: {}, name: 'write' },
      }),
      method: 'POST',
    };
    expect(
      applyRegisteredExtensionHttpHeaders(init, registry, new RegisteredExtensionDispatchLedger())
    ).toBe(init);
  });

  it('still validates a tools/call that the registry dispatched', () => {
    const registry = new McpClientExtensionRegistry();
    registerMcpTasksWireContracts(registry);
    const body = JSON.stringify({
      id: 7,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'write' },
    });
    const dispatched = new RegisteredExtensionDispatchLedger();
    dispatched.openTransportScope().trackDispatchedRequest(7);
    expect(() =>
      applyRegisteredExtensionHttpHeaders({ body, method: 'POST' }, registry, dispatched)
    ).toThrow('method/header mismatch');
    expect(
      new Headers(
        applyRegisteredExtensionHttpHeaders(
          { body, headers: { 'mcp-method': 'tools/call' }, method: 'POST' },
          registry,
          dispatched
        )?.headers
      ).get('mcp-name')
    ).toBe('write');
  });

  it('rejects an unexpected Mcp-Name when the contract declares no name parameter', () => {
    expect(() =>
      applyRegisteredExtensionHttpHeaders(
        {
          body: JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            method: 'tasks/update',
            params: { taskId: 'task-123' },
          }),
          headers: { 'mcp-method': 'tasks/update', 'mcp-name': 'task-123' },
          method: 'POST',
        },
        registryWithoutMcpName()
      )
    ).toThrow('unexpected Mcp-Name');
  });
});
