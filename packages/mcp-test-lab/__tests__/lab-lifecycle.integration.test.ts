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
      untriggeredFaultIds: ['unused-tool-fault'],
    });
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
      untriggeredFaultIds: [],
    });
    expect(lab.closed).toBe(true);
    await expect(fetch(lab.endpoint.url)).rejects.toThrow();
  });
});
