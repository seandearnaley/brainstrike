import { InMemoryServerEventBus, type McpHttpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { claimMcpLabFaultPlan } from '../src/fault-plan-claim';
import { createMcpLabFaultRuntime } from '../src/fault-runtime';
import { createMcpLabFaultPlan } from '../src/faults';
import { withMcpLabHttpFaults } from '../src/http-fault-handler';

function modernRequest(correlationId?: string): Request {
  const method = 'tools/list';
  return new Request('http://mcp-lab.invalid/mcp', {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method,
      params: {
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'handler-test', version: '1' },
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      },
    }),
    headers: {
      'content-type': 'application/json',
      'mcp-method': method,
      'mcp-protocol-version': '2026-07-28',
      ...(correlationId ? { 'x-mcp-lab-correlation-id': correlationId } : {}),
    },
    method: 'POST',
  });
}

describe('MCP HTTP fault executor', () => {
  it('qualifies once, preserves the original body, and rejects reused correlations', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'first-tools-list',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'second-tools-list',
        match: { method: 'tools/list', occurrence: 2, phase: 'operation' },
      },
    ]);
    const downstream: McpHttpHandler = {
      bus: new InMemoryServerEventBus(),
      close: async () => undefined,
      fetch: async (request) => Response.json(await request.json()),
      notify: {
        promptsChanged: () => undefined,
        resourcesChanged: () => undefined,
        resourceUpdated: () => undefined,
        toolsChanged: () => undefined,
      },
    };
    const handler = withMcpLabHttpFaults(
      downstream,
      createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'modern-reference'),
      () => undefined,
      'modern'
    );
    expect((await handler.fetch(modernRequest('caller.safe:1'))).status).toBe(200);
    await expect(handler.fetch(modernRequest('caller.safe:1'))).rejects.toThrow(
      /duplicate.*correlation/i
    );
    expect(plan.observations()).toEqual([
      expect.objectContaining({ correlationId: 'caller.safe:1', faultId: 'first-tools-list' }),
    ]);
  });
  it('assigns concurrent occurrences in ingress order, not clone-completion order', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'first-ingress',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
      {
        fault: { kind: 'http_status', status: 429 },
        id: 'second-ingress',
        match: { method: 'tools/list', occurrence: 2, phase: 'operation' },
      },
    ]);
    const downstream: McpHttpHandler = {
      bus: new InMemoryServerEventBus(),
      close: async () => undefined,
      fetch: async () => Response.json({ ok: true }),
      notify: {
        promptsChanged: () => undefined,
        resourcesChanged: () => undefined,
        resourceUpdated: () => undefined,
        toolsChanged: () => undefined,
      },
    };
    const handler = withMcpLabHttpFaults(
      downstream,
      createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'modern-reference'),
      () => undefined,
      'modern'
    );
    let releaseFirst: () => void = () => {
      throw new Error('First clone gate was not installed');
    };
    const firstCloneGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = modernRequest();
    const firstClone = first.clone();
    vi.spyOn(firstClone, 'json').mockImplementation(async () => {
      await firstCloneGate;
      const parsed: unknown = JSON.parse(await firstClone.text());
      return parsed;
    });
    vi.spyOn(first, 'clone').mockReturnValue(firstClone);

    const firstResponse = handler.fetch(first);
    const secondResponse = handler.fetch(modernRequest());
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirst();

    await expect(firstResponse).resolves.toMatchObject({ status: 418 });
    await expect(secondResponse).resolves.toMatchObject({ status: 429 });
    expect(plan.observations().map(({ faultId }) => faultId)).toEqual([
      'first-ingress',
      'second-ingress',
    ]);
  });
  it('waits for active delay faults before closing the downstream handler', async () => {
    vi.useFakeTimers();
    let downstreamClosed = false;
    const plan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 25, kind: 'delay' },
        id: 'active-delay',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
    ]);
    const handler = withMcpLabHttpFaults(
      {
        bus: new InMemoryServerEventBus(),
        close: async () => {
          downstreamClosed = true;
        },
        fetch: async () => Response.json({ ok: true }),
        notify: {
          promptsChanged: () => undefined,
          resourcesChanged: () => undefined,
          resourceUpdated: () => undefined,
          toolsChanged: () => undefined,
        },
      },
      createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'modern-reference'),
      () => undefined,
      'modern'
    );
    try {
      const response = handler.fetch(modernRequest());
      await vi.advanceTimersByTimeAsync(0);
      expect(plan.untriggeredIds()).toEqual([]);
      const closing = handler.close();
      await vi.advanceTimersByTimeAsync(24);
      expect(downstreamClosed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(response).resolves.toMatchObject({ status: 200 });
      await expect(closing).resolves.toBeUndefined();
      expect(downstreamClosed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
