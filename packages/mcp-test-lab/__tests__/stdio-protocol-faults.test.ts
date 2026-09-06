import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { claimMcpLabFaultPlan } from '../src/fault-plan-claim';
import { createMcpLabFaultRuntime } from '../src/fault-runtime';
import { createMcpLabFaultPlan } from '../src/faults';
import { McpLabStdioProtocolFaults } from '../src/stdio-protocol-faults';

function request(id: number | string): JSONRPCMessage {
  return {
    id,
    jsonrpc: '2.0',
    method: 'tools/list',
    params: {
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'stdio-protocol-test', version: '1' },
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      },
    },
  };
}

function response(id: number | string): JSONRPCMessage {
  return { id, jsonrpc: '2.0', result: { tools: [] } };
}

function delivered(faults: McpLabStdioProtocolFaults, message: JSONRPCMessage): boolean {
  let wasDelivered = false;
  faults.receive(message, () => {
    wasDelivered = true;
  });
  return wasDelivered;
}

describe('MCP stdio protocol faults', () => {
  it('does not serialize sends when no stdio protocol fault is configured', async () => {
    const faults = new McpLabStdioProtocolFaults(
      createMcpLabFaultRuntime(undefined, 'stdio-no-fault-test'),
      'modern'
    );
    const firstSend = Promise.withResolvers<void>();
    const started: number[] = [];
    const first = faults.send(request(1), () => {
      started.push(1);
      return firstSend.promise;
    });
    const second = faults.send(request(2), async () => {
      started.push(2);
    });
    await second;
    expect(started).toEqual([1, 2]);
    firstSend.resolve();
    await first;
  });

  it('distinguishes numeric and string response ids and suppresses only each exact match', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'drop-numeric-id',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
      {
        fault: { kind: 'drop_response' },
        id: 'drop-string-id',
        match: { method: 'tools/list', occurrence: 2, phase: 'operation' },
      },
    ]);
    const faults = new McpLabStdioProtocolFaults(
      createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'stdio-id-test'),
      'modern'
    );

    await faults.send(request(1), async () => undefined);
    expect(delivered(faults, response('1'))).toBe(true);
    expect(delivered(faults, response(1))).toBe(false);
    await faults.send(request('1'), async () => undefined);
    expect(delivered(faults, response(1))).toBe(true);
    await faults.close();
    faults.finishClose();
    expect(delivered(faults, response('1'))).toBe(true);
  });

  it('buffers a response delivered before delegate send resolves and suppresses it on commit', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'drop-fast-response',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
    ]);
    const faults = new McpLabStdioProtocolFaults(
      createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'stdio-fast-response-test'),
      'modern'
    );
    const deliveredResponses: JSONRPCMessage[] = [];

    await faults.send(request(1), async () => {
      faults.receive(response(1), () => deliveredResponses.push(response(1)));
      expect(deliveredResponses).toEqual([]);
    });
    expect(deliveredResponses).toEqual([]);
    expect(plan.untriggeredIds()).toEqual([]);
  });

  it('does not consume or advance a drop fault when delegate send fails', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'drop-after-send',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
    ]);
    const faults = new McpLabStdioProtocolFaults(
      createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'stdio-send-test'),
      'modern'
    );

    const deliveredResponses: JSONRPCMessage[] = [];
    await expect(
      faults.send(request(1), async () => {
        faults.receive(response(1), () => deliveredResponses.push(response(1)));
        expect(deliveredResponses).toEqual([]);
        throw new Error('send failed');
      })
    ).rejects.toThrow('send failed');
    expect(deliveredResponses).toEqual([response(1)]);
    expect(plan.untriggeredIds()).toEqual(['drop-after-send']);
    await faults.send(request(2), async () => undefined);
    expect(delivered(faults, response(2))).toBe(false);
  });

  it('rejects every non-coordinate class without observations or occurrence advancement', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'first-valid-request',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
    ]);
    const faults = new McpLabStdioProtocolFaults(
      createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'stdio-invalid-test'),
      'modern'
    );
    const sent: unknown[] = [];
    const send = async (message: unknown) => {
      sent.push(message);
    };

    const rejectedMessages = [
      response(1),
      [request(1)],
      {
        id: 2,
        jsonrpc: '2.0',
        method: 'sampling/createMessage',
        params: { maxTokens: 1, messages: [] },
      },
      { ...request(3), method: 'resources/list' },
      { id: 4, jsonrpc: '2.0', method: 'tools/list', params: [] },
      {
        id: 5,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          capabilities: {},
          clientInfo: { name: 'legacy-client', version: '1' },
          protocolVersion: '2025-11-25',
        },
      },
    ];
    for (const message of rejectedMessages) {
      await faults.send(message as JSONRPCMessage, () => send(message));
    }
    expect(plan.untriggeredIds()).toEqual(['first-valid-request']);
    expect(plan.observations()).toEqual([]);
    await faults.send(request(6), () => send(request(6)));
    expect(delivered(faults, response(6))).toBe(false);
    expect(plan.observations()).toEqual([
      expect.objectContaining({
        faultId: 'first-valid-request',
        occurrence: 1,
      }),
    ]);
    expect(sent).toHaveLength(rejectedMessages.length + 1);
  });

  it('does not advance modern notification faults for a legacy-shaped stdio envelope', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'first-modern-progress',
        match: { method: 'notifications/progress', occurrence: 1, phase: 'subscription' },
      },
    ]);
    const faults = new McpLabStdioProtocolFaults(
      createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'stdio-notification-era-test'),
      'modern'
    );
    const legacyNotification = {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progress: 1, progressToken: 'legacy-progress' },
    } as const;
    const modernNotification = {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
        progress: 1,
        progressToken: 'modern-progress',
      },
    } as const;

    await faults.send(legacyNotification, async () => undefined);
    expect(plan.observations()).toEqual([]);
    expect(plan.untriggeredIds()).toEqual(['first-modern-progress']);

    await faults.send(modernNotification, async () => undefined);
    expect(plan.observations()).toEqual([
      expect.objectContaining({ faultId: 'first-modern-progress', occurrence: 1 }),
    ]);
    expect(plan.untriggeredIds()).toEqual([]);
  });

  it('waits for an active delay before closing and preserves invocation order', async () => {
    vi.useFakeTimers();
    const plan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 25, kind: 'delay' },
        id: 'first-delay',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
    ]);
    const faults = new McpLabStdioProtocolFaults(
      createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'stdio-delay-test'),
      'modern'
    );
    const sent: number[] = [];

    try {
      const first = faults.send(request(1), async () => {
        sent.push(1);
      });
      const second = faults.send(request(2), async () => {
        sent.push(2);
      });
      const closing = faults.close();
      await expect(faults.send(request(3), async () => undefined)).rejects.toThrow(
        'executor is closing'
      );
      await vi.advanceTimersByTimeAsync(24);
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([first, second, closing]);
      expect(sent).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });
});
