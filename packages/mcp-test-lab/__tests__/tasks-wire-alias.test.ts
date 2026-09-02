import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  installTasksClientWireAlias,
  installTasksServerWireAlias,
  restoreCompleteResultType,
  TASKS_LAB_RESULT_KEY,
  TASKS_WIRE_ALIASES,
  unwrapTasksToolResult,
} from '../src/tasks-wire-alias';

interface FakeTransport extends Transport {
  deliver: (message: JSONRPCMessage) => void;
  readonly sent: JSONRPCMessage[];
}

function createTransport(): FakeTransport {
  const transport: FakeTransport = {
    async close() {},
    deliver(message) {
      transport.onmessage?.(message);
    },
    async send(message) {
      transport.sent.push(message);
    },
    sent: [],
    async start() {},
  };
  return transport;
}

describe('MCP Tasks lab wire alias bridge', () => {
  it('rewrites only aliased requests to the official wire methods on the way out', async () => {
    const transport = installTasksClientWireAlias(createTransport());
    await transport.send({ id: 1, jsonrpc: '2.0', method: TASKS_WIRE_ALIASES['tasks/get'] });
    await transport.send({ id: 2, jsonrpc: '2.0', method: 'tools/list' });
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(transport.sent.map((message) => ('method' in message ? message.method : ''))).toEqual([
      'tasks/get',
      'tools/list',
      'notifications/initialized',
    ]);
  });

  it('wraps a task tool result as complete only for a pending tools/call, once', async () => {
    const transport = installTasksClientWireAlias(createTransport());
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => {
      received.push(message);
    };
    await transport.send({ id: 7, jsonrpc: '2.0', method: 'tools/call', params: { name: 't' } });
    const task = { resultType: 'task', status: 'working', taskId: 'task-1' };
    transport.deliver({ id: 7, jsonrpc: '2.0', result: task });
    transport.deliver({ id: 7, jsonrpc: '2.0', result: task });
    transport.deliver({ id: 8, jsonrpc: '2.0', result: task });
    expect(received).toEqual([
      {
        id: 7,
        jsonrpc: '2.0',
        result: { [TASKS_LAB_RESULT_KEY]: task, content: [], resultType: 'complete' },
      },
      { id: 7, jsonrpc: '2.0', result: task },
      { id: 8, jsonrpc: '2.0', result: task },
    ]);
    expect(
      unwrapTasksToolResult(received[0] && 'result' in received[0] ? received[0].result : {})
    ).toBe(task);
    expect(unwrapTasksToolResult(task)).toBe(task);
  });

  it('does not let a server-initiated request with a colliding id consume the marker', async () => {
    const transport = installTasksClientWireAlias(createTransport());
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => {
      received.push(message);
    };
    const task = { resultType: 'task', status: 'working', taskId: 'task-1' };
    await transport.send({ id: 5, jsonrpc: '2.0', method: 'tools/call', params: { name: 't' } });
    transport.deliver({ id: 5, jsonrpc: '2.0', method: 'elicitation/create', params: {} });
    transport.deliver({ id: 5, jsonrpc: '2.0', result: task });
    expect(received[1]).toEqual({
      id: 5,
      jsonrpc: '2.0',
      result: { [TASKS_LAB_RESULT_KEY]: task, content: [], resultType: 'complete' },
    });
  });

  it('releases a pending tools/call on local cancellation and on close', async () => {
    const transport = installTasksClientWireAlias(createTransport());
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => {
      received.push(message);
    };
    const task = { resultType: 'task', status: 'working', taskId: 'task-1' };
    await transport.send({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: { name: 't' } });
    await transport.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    });
    transport.deliver({ id: 1, jsonrpc: '2.0', result: task });
    await transport.send({ id: 2, jsonrpc: '2.0', method: 'tools/call', params: { name: 't' } });
    await transport.close();
    transport.deliver({ id: 2, jsonrpc: '2.0', result: task });
    expect(received).toEqual([
      { id: 1, jsonrpc: '2.0', result: task },
      { id: 2, jsonrpc: '2.0', result: task },
    ]);
  });

  it('restores the lifted complete result type without overwriting an explicit one', () => {
    expect(restoreCompleteResultType({ status: 'working' })).toEqual({
      resultType: 'complete',
      status: 'working',
    });
    expect(restoreCompleteResultType({ resultType: 'task' })).toEqual({ resultType: 'task' });
    expect(restoreCompleteResultType('raw')).toBe('raw');
  });

  it('survives the SDK chaining the existing handler from inside its own', () => {
    const transport = installTasksClientWireAlias(createTransport());
    const seen: string[] = [];
    // Mirrors Protocol.connect: read the current handler, then install one that calls it.
    const previous = transport.onmessage;
    transport.onmessage = (message, extra) => {
      previous?.(message, extra);
      seen.push('id' in message ? String(message.id) : 'notification');
    };
    transport.deliver({ id: 3, jsonrpc: '2.0', result: { resultType: 'complete' } });
    expect(seen).toEqual(['3']);
  });

  it('dispatches official wire methods to the aliased server handlers', async () => {
    const transport = createTransport();
    const server = installTasksServerWireAlias(
      new McpServer({ name: 'alias-test', version: '1.0.0' }, { capabilities: {} })
    );
    const dispatched: string[] = [];
    const original = server.server.connect.bind(server.server);
    server.server.connect = async (next) => {
      await original(next);
      const downstream = next.onmessage;
      next.onmessage = (message, extra) => {
        dispatched.push('method' in message ? message.method : '');
        downstream?.(message, extra);
      };
    };
    await server.connect(transport);
    transport.deliver({ id: 1, jsonrpc: '2.0', method: 'tasks/update', params: { taskId: 't' } });
    transport.deliver({ id: 2, jsonrpc: '2.0', method: 'tools/list' });
    expect(dispatched).toEqual([TASKS_WIRE_ALIASES['tasks/update'], 'tools/list']);
    await server.close();
  });
});
