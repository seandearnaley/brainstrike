import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createMcpLabFaultPlan } from '../src/faults';
import { startMcpLabScenario } from '../src/lab';

describe('MCP lab fault and cleanup lifecycle', () => {
  it('injects configured transport faults into a real exchange and records handler diagnostics', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'drop-first-request',
        match: { method: 'http/request', occurrence: 1, phase: 'transport' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', { faultPlan });
    if (lab.endpoint.kind !== 'loopback-http') {
      throw new Error(`Expected loopback HTTP endpoint, received ${lab.endpoint.kind}`);
    }

    const response = await fetch(lab.endpoint.url, { method: 'POST' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: -32_603, message: 'Internal server error' },
      id: null,
      jsonrpc: '2.0',
    });
    expect(lab.diagnostics()).toEqual([
      expect.objectContaining({
        correlationId: 'modern-reference:exchange:1',
        kind: 'handler-error',
        message: expect.stringContaining('drop-first-request'),
      }),
    ]);
    await expect(lab.close()).resolves.toEqual({
      httpListenersClosed: 1,
      stdioTransportsClosed: 0,
      untriggeredFaultIds: [],
    });
  });

  it('reports untriggered faults from the attached plan instead of hardcoding cleanup evidence', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'unused-tool-fault',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', { faultPlan });

    await expect(lab.close()).resolves.toEqual({
      httpListenersClosed: 1,
      stdioTransportsClosed: 0,
      untriggeredFaultIds: ['unused-tool-fault'],
    });
  });

  it('does not consume a child-exit fault until the lab-owned stdio transport starts', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { code: 7, kind: 'child_exit', signal: null },
        id: 'exit-after-spawn',
        match: { method: 'child/exit', occurrence: 1, phase: 'child-process' },
      },
    ]);
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan });

    await expect(lab.close()).resolves.toEqual({
      httpListenersClosed: 0,
      stdioTransportsClosed: 1,
      untriggeredFaultIds: ['exit-after-spawn'],
    });
  });

  it('captures child stderr without persisting its contents and owns teardown', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'child_stderr', text: 'fixture stderr details' },
        id: 'emit-child-stderr',
        match: { method: 'child/stderr', occurrence: 1, phase: 'child-process' },
      },
    ]);
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan });
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const client = new Client(
      { name: 'brainstrike-mcp-lab-stderr-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );

    try {
      await client.connect(lab.endpoint.transport);
      await expect
        .poll(() => lab.diagnostics())
        .toEqual([
          expect.objectContaining({
            kind: 'child-stderr',
            message: expect.stringMatching(/^captured [1-9][0-9]* stderr bytes$/u),
          }),
        ]);
      expect(JSON.stringify(lab.diagnostics())).not.toContain('fixture stderr details');
    } finally {
      await client.close();
      await lab.close();
    }

    expect(lab.endpoint.transport.pid).toBeNull();
    expect(faultPlan.untriggeredIds()).toEqual([]);
  });

  it('executes every accepted operation fault through a real protocol request', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'subscribe-status',
        match: { method: 'resources/subscribe', occurrence: 1, phase: 'operation' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', { faultPlan });
    if (lab.endpoint.kind !== 'loopback-http') {
      throw new Error(`Expected loopback HTTP endpoint, received ${lab.endpoint.kind}`);
    }

    const response = await fetch(lab.endpoint.url, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'resources/subscribe',
        params: { uri: 'file:///fixture.txt' },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(418);
    await expect(lab.close()).resolves.toMatchObject({ untriggeredFaultIds: [] });
  });

  it('covers dispatcher rejection at the outer loopback error boundary', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'reject-dispatch',
        match: { method: 'node/dispatch', occurrence: 1, phase: 'transport' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', { faultPlan });
    if (lab.endpoint.kind !== 'loopback-http') {
      throw new Error(`Expected loopback HTTP endpoint, received ${lab.endpoint.kind}`);
    }

    const response = await fetch(lab.endpoint.url);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      correlationId: 'modern-reference:exchange:1',
      error: 'mcp_lab_handler_error',
    });
    await expect(lab.close()).resolves.toMatchObject({ untriggeredFaultIds: [] });
  });

  it('keeps failed cleanup retryable and reports closed only after every resource closes', async () => {
    const faultPlan = createMcpLabFaultPlan([
      {
        fault: { kind: 'drop_response' },
        id: 'fail-first-close',
        match: { method: 'transport/close', occurrence: 1, phase: 'shutdown' },
      },
    ]);
    const lab = await startMcpLabScenario('modern-reference', { faultPlan });
    if (lab.endpoint.kind !== 'loopback-http') {
      throw new Error(`Expected loopback HTTP endpoint, received ${lab.endpoint.kind}`);
    }

    await expect(lab.close()).rejects.toThrow('fail-first-close');
    expect(lab.closed).toBe(false);
    expect(lab.diagnostics()).toEqual([
      expect.objectContaining({
        kind: 'cleanup-error',
        message: expect.stringContaining('fail-first-close'),
      }),
    ]);
    expect((await fetch(lab.endpoint.url)).status).toBe(405);

    await expect(lab.close()).resolves.toEqual({
      httpListenersClosed: 1,
      stdioTransportsClosed: 0,
      untriggeredFaultIds: [],
    });
    expect(lab.closed).toBe(true);
    await expect(fetch(lab.endpoint.url)).rejects.toThrow();
  });
});
