import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createMcpLabFaultPlan } from '../src/faults';
import { startMcpLabScenario } from '../src/lab';

describe('MCP lab modern reference', () => {
  it('snapshots accessor-backed start options exactly once before validation and startup', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'loopback-dispatch-only',
        match: { method: 'node/dispatch', occurrence: 1, phase: 'transport' },
      },
    ]);
    let executionReads = 0;
    let faultPlanReads = 0;
    const options = Object.defineProperties(
      {},
      {
        execution: {
          enumerable: true,
          get() {
            executionReads += 1;
            return executionReads === 1 ? 'in-process' : 'loopback';
          },
        },
        faultPlan: {
          enumerable: true,
          get() {
            faultPlanReads += 1;
            return faultPlanReads === 1 ? faultPlan : undefined;
          },
        },
      }
    );
    let lab: Awaited<ReturnType<typeof startMcpLabScenario>> | undefined;
    let caught: unknown;
    try {
      lab = await startMcpLabScenario('modern-reference', options);
    } catch (error) {
      caught = error;
    } finally {
      await lab?.close();
    }

    expect(String(caught)).toMatch(/incompatible.*http-in-process/i);
    expect(executionReads).toBe(1);
    expect(faultPlanReads).toBe(1);
  });

  it.each([
    ['unknown execution', { execution: 'typo' }],
    ['null execution', { execution: null }],
    ['false execution', { execution: false }],
    ['unknown option', { unexpected: true }],
    ['null fault plan', { faultPlan: null }],
    [
      'fabricated fault plan',
      {
        faultPlan: {
          assertCompatibleWithTransport() {},
          assertFullyConsumed() {},
          consume() {
            throw new Error('impostor consume');
          },
          consumeIfConfigured() {},
          hasRemainingPhase() {
            return false;
          },
          observations() {
            return [];
          },
          untriggeredIds() {
            return [];
          },
        },
      },
    ],
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
          method: 'notifications/progress',
          occurrence: 1,
          phase: 'subscription',
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

  it.each(['elicitation/create', 'roots/list', 'sampling/createMessage'] as const)(
    'rejects inbound-only %s faults before starting stdio',
    async (method) => {
      const faultPlan = createMcpLabFaultPlan([
        {
          fault: { delayMs: 1, kind: 'delay' },
          id: 'inbound-only-stdio',
          match: { method, occurrence: 1, phase: 'operation' },
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
    }
  );

  it.each([
    'notifications/message',
    'notifications/prompts/list_changed',
    'notifications/resources/list_changed',
    'notifications/resources/updated',
    'notifications/tools/list_changed',
  ] as const)('rejects server-originated %s faults before starting stdio', async (method) => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'server-notification-stdio',
        match: { method, occurrence: 1, phase: 'subscription' },
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

  it('rejects server-to-client coordinates for HTTP server sessions', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'roots-list-inbound-only',
        match: { method: 'roots/list', occurrence: 1, phase: 'operation' },
      },
    ]);
    await expect(
      startMcpLabScenario('modern-reference', { execution: 'in-process', faultPlan })
    ).rejects.toThrow(/incompatible.*in-process/i);
  });

  it.each(['modern-reference', 'legacy-reference'] as const)(
    'rejects authorization faults for non-OAuth scenario %s',
    async (scenarioId) => {
      const faultPlan = createMcpLabFaultPlan([
        {
          fault: { delayMs: 1, kind: 'delay' },
          id: 'oauth-token-without-oauth',
          match: { method: 'oauth/token', occurrence: 1, phase: 'authorization' },
        },
      ]);
      await expect(startMcpLabScenario(scenarioId, { faultPlan })).rejects.toThrow(
        /incompatible.*authentication|OAuth/i
      );
    }
  );

  it.each(['initialize', 'notifications/initialized', 'ping'] as const)(
    'rejects legacy-only %s faults for modern scenarios',
    async (method) => {
      const faultPlan = createMcpLabFaultPlan([
        {
          fault: { delayMs: 1, kind: 'delay' },
          id: 'legacy-only-modern',
          match: { method, occurrence: 1, phase: 'initialization' },
        },
      ]);
      await expect(
        startMcpLabScenario('modern-reference', { execution: 'in-process', faultPlan })
      ).rejects.toThrow(/incompatible.*modern/i);
    }
  );

  it('accepts server/discover for modern negotiation and rejects it for legacy', async () => {
    const modernPlan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'modern-discovery',
        match: { method: 'server/discover', occurrence: 1, phase: 'initialization' },
      },
    ] as never);
    const modernLab = await startMcpLabScenario('modern-reference', {
      execution: 'in-process',
      faultPlan: modernPlan,
    });
    await modernLab.close();

    const legacyPlan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 1, kind: 'delay' },
        id: 'legacy-discovery',
        match: { method: 'server/discover', occurrence: 1, phase: 'initialization' },
      },
    ] as never);
    await expect(
      startMcpLabScenario('legacy-reference', { faultPlan: legacyPlan })
    ).rejects.toThrow(/incompatible.*legacy/i);
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
