import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createMcpLabFaultPlan } from '../src/faults';
import { startMcpLabScenario } from '../src/lab';
import { processIsGone } from './process-liveness';

function cleanupFailurePlan(id: string) {
  return createMcpLabFaultPlan([
    {
      fault: { kind: 'cleanup_error' },
      id,
      match: { method: 'transport/close', occurrence: 1, phase: 'shutdown' },
    },
  ]);
}

describe('MCP cleanup fault execution', () => {
  it.each(['in-process', 'loopback'] as const)(
    'retains %s HTTP session ownership until cleanup retry succeeds',
    async (execution) => {
      const plan = cleanupFailurePlan(`${execution}-cleanup-failure`);
      const lab = await startMcpLabScenario('modern-reference', { execution, faultPlan: plan });

      await expect(lab.close()).rejects.toThrow(/cleanup-failure.*cleanup failure/i);
      expect(lab.closed).toBe(false);
      if (lab.endpoint.kind === 'stdio') {
        throw new Error('Expected an HTTP endpoint');
      }
      const response =
        lab.endpoint.kind === 'in-process-http'
          ? await lab.endpoint.fetch(lab.endpoint.url, { method: 'GET' })
          : await fetch(lab.endpoint.url, {
              headers: { origin: lab.endpoint.url.origin },
              method: 'GET',
            });
      expect(response.status).toBe(405);
      await response.body?.cancel();
      const report = await lab.close();
      expect(report).toMatchObject({
        httpListenersClosed: execution === 'loopback' ? 1 : 0,
        untriggeredFaultIds: [],
      });
      expect(lab.closed).toBe(true);
    }
  );

  it('retains OAuth records through injected cleanup failure and clears them on retry', async () => {
    const plan = cleanupFailurePlan('oauth-cleanup-failure');
    const lab = await startMcpLabScenario('oauth-reference', {
      execution: 'loopback',
      faultPlan: plan,
    });
    if (lab.endpoint.kind !== 'oauth-loopback-http') {
      throw new Error(`Expected OAuth loopback endpoint, received ${lab.endpoint.kind}`);
    }

    const registration = await fetch(lab.endpoint.registrationUrl, {
      body: JSON.stringify({
        application_type: 'native',
        client_name: 'Cleanup Ownership Client',
        grant_types: ['authorization_code'],
        redirect_uris: ['http://127.0.0.1:54321/callback'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(registration.status).toBe(201);
    expect(lab.endpoint.stateCounts()).toEqual({ clients: 1, codes: 0, states: 0, tokens: 0 });

    await expect(lab.close()).rejects.toThrow(/oauth-cleanup-failure.*cleanup failure/i);
    expect(lab.closed).toBe(false);
    expect(lab.endpoint.stateCounts()).toEqual({ clients: 1, codes: 0, states: 0, tokens: 0 });
    await expect(lab.close()).resolves.toMatchObject({
      httpListenersClosed: 1,
      oauthRecordsRemaining: { clients: 0, codes: 0, states: 0, tokens: 0 },
      untriggeredFaultIds: [],
    });
  });

  it('retains a spawned stdio child through cleanup failure and reaps it on retry', async () => {
    const plan = cleanupFailurePlan('stdio-cleanup-failure');
    const lab = await startMcpLabScenario('stdio-reference', { faultPlan: plan });
    if (lab.endpoint.kind !== 'stdio') {
      throw new Error(`Expected stdio endpoint, received ${lab.endpoint.kind}`);
    }
    const client = new Client(
      { name: 'cleanup-ownership-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    await client.connect(lab.endpoint.transport);
    const childPid = lab.endpoint.transport.pid;
    if (childPid === null) {
      throw new Error('Expected a spawned stdio child');
    }

    await expect(lab.close()).rejects.toThrow(/stdio-cleanup-failure.*cleanup failure/i);
    expect(processIsGone(childPid)).toBe(false);
    await expect(lab.close()).resolves.toEqual({
      httpListenersClosed: 0,
      stdioTransportsClosed: 1,
      untriggeredFaultIds: [],
    });
    await expect.poll(() => processIsGone(childPid), { timeout: 2000 }).toBe(true);
    await client.close();
  });
});
