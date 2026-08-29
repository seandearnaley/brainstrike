import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createMcpLabFaultPlan } from '../src/faults';
import { startMcpLabScenario } from '../src/lab';

describe('MCP lab modern reference', () => {
  it.each([
    ['unknown execution', { execution: 'typo' }],
    ['null execution', { execution: null }],
    ['false execution', { execution: false }],
    ['unknown option', { unexpected: true }],
    ['null fault plan', { faultPlan: null }],
    ['null options', null],
  ])('rejects %s before dispatching a scenario', async (_label, options) => {
    let lab: Awaited<ReturnType<typeof startMcpLabScenario>> | undefined;
    let caught: unknown;
    try {
      lab = await startMcpLabScenario('modern-reference', options as never);
    } catch (error) {
      caught = error;
    } finally {
      await lab?.close();
    }

    expect(String(caught)).toMatch(/Invalid MCP lab start options/);
  });

  it.each([
    { kind: 'http_status', status: 503 },
    { kind: 'malformed_json', payload: '{' },
  ] as const)('rejects HTTP-only fault %j before starting stdio', async (fault) => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault,
        id: 'stdio-incompatible',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
    ]);
    let lab: Awaited<ReturnType<typeof startMcpLabScenario>> | undefined;
    let caught: unknown;
    try {
      lab = await startMcpLabScenario('stdio-reference', { faultPlan });
    } catch (error) {
      caught = error;
    } finally {
      await lab?.close();
    }

    expect(String(caught)).toMatch(/incompatible.*stdio/i);
  });

  it('rejects drop_response on a stdio notification before starting', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'drop-notification',
        match: {
          method: 'notifications/initialized',
          occurrence: 1,
          phase: 'initialization',
        },
      },
    ]);
    let lab: Awaited<ReturnType<typeof startMcpLabScenario>> | undefined;
    let caught: unknown;
    try {
      lab = await startMcpLabScenario('stdio-reference', { faultPlan });
    } catch (error) {
      caught = error;
    } finally {
      await lab?.close();
    }

    expect(String(caught)).toMatch(/incompatible.*stdio/i);
  });

  it('rejects node/dispatch faults for in-process HTTP execution', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'node-dispatch-only',
        match: { method: 'node/dispatch', occurrence: 1, phase: 'transport' },
      },
    ]);
    let lab: Awaited<ReturnType<typeof startMcpLabScenario>> | undefined;
    let caught: unknown;
    try {
      lab = await startMcpLabScenario('modern-reference', {
        execution: 'in-process',
        faultPlan,
      });
    } catch (error) {
      caught = error;
    } finally {
      await lab?.close();
    }

    expect(String(caught)).toMatch(/incompatible.*in-process/i);
  });

  it('negotiates 2026-07-28 and exercises a real official SDK tool exchange', async () => {
    const lab = await startMcpLabScenario('modern-reference', { execution: 'in-process' });
    if (lab.endpoint.kind !== 'in-process-http') {
      throw new Error(`Expected in-process HTTP endpoint, received ${lab.endpoint.kind}`);
    }
    const client = new Client(
      { name: 'brainstrike-mcp-lab-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    const transport = new StreamableHTTPClientTransport(lab.endpoint.url, {
      fetch: lab.endpoint.fetch,
    });

    try {
      await client.connect(transport);

      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(client.getServerVersion()).toEqual({
        name: 'brainstrike-sdk-v2-reference',
        version: '2.0.0',
      });

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(['echo']);

      const result = await client.callTool({
        arguments: { text: 'verified' },
        name: 'echo',
      });
      expect(result).toMatchObject({
        content: [{ text: 'verified', type: 'text' }],
        structuredContent: { text: 'verified' },
      });
    } finally {
      await client.close();
      await expect(lab.close()).resolves.toEqual({
        httpListenersClosed: 0,
        stdioTransportsClosed: 0,
        untriggeredFaultIds: [],
      });
    }

    expect(lab.closed).toBe(true);
  });
});
